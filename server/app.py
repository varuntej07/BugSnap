from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import threading
import time
from collections import defaultdict, deque
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from prompt_builder import build_prompts
from vlm import InferenceConfig, VisionLanguageBackend, load_backend

LOGGER = logging.getLogger("bugsnap.server")

PromptMode = Literal["ui_bug_fix", "ui_polish", "implement_like_this"]
ElementType = Literal["button", "input", "modal", "nav", "card", "table", "text"]


def env_value(primary_name: str, legacy_name: str | None = None) -> str | None:
    raw = os.getenv(primary_name)
    if raw is not None:
        return raw
    if legacy_name is not None:
        return os.getenv(legacy_name)
    return None


def env_int(primary_name: str, default: int, legacy_name: str | None = None) -> int:
    raw = env_value(primary_name, legacy_name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning(
            "Invalid integer env '%s'=%r, falling back to %s",
            primary_name,
            raw,
            default,
        )
        return default


logging.basicConfig(level=env_value("BUGSNAP_LOG_LEVEL", "SNAPPROMPT_LOG_LEVEL") or "INFO")

MAX_REQUEST_MB = env_int("BUGSNAP_MAX_REQUEST_MB", 6, "SNAPPROMPT_MAX_REQUEST_MB")
MAX_REQUEST_BYTES = MAX_REQUEST_MB * 1024 * 1024
MAX_IMAGE_MB = env_int("BUGSNAP_MAX_IMAGE_MB", 5, "SNAPPROMPT_MAX_IMAGE_MB")
MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024
RATE_LIMIT_PER_MINUTE = env_int("BUGSNAP_RATE_LIMIT_PER_MINUTE", 12, "SNAPPROMPT_RATE_LIMIT_PER_MINUTE")
RATE_LIMIT_WINDOW_SECONDS = 60
Image.MAX_IMAGE_PIXELS = env_int("BUGSNAP_MAX_IMAGE_PIXELS", 40_000_000, "SNAPPROMPT_MAX_IMAGE_PIXELS")


class DetectedElementModel(BaseModel):
    type: ElementType
    notes: str


class DescribeResponseModel(BaseModel):
    ui_summary: str
    detected_elements: list[DetectedElementModel]
    suspected_issues: list[str]
    prompt_short: str
    prompt_verbose: str


class SlidingWindowRateLimiter:
    def __init__(self, limit: int, window_seconds: int) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()

        with self._lock:
            bucket = self._events[key]
            while bucket and now - bucket[0] > self.window_seconds:
                bucket.popleft()

            if len(bucket) >= self.limit:
                return False

            bucket.append(now)
            return True


def decode_base64_image(image_base64: str) -> bytes:
    candidate = image_base64.strip()
    if candidate.startswith("data:") and "," in candidate:
        candidate = candidate.split(",", 1)[1]

    try:
        return base64.b64decode(candidate, validate=True)
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image payload: {error}") from error


def image_from_bytes(payload: bytes) -> Image.Image:
    if not payload:
        raise HTTPException(status_code=400, detail="Image payload is empty.")
    if len(payload) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"Image exceeds {MAX_IMAGE_MB}MB limit.")

    try:
        with Image.open(io.BytesIO(payload)) as image:
            return image.convert("RGB")
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=400, detail="Unsupported image format.") from error
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not decode image: {error}") from error


app = FastAPI(
    title="BugSnap Local VLM Server",
    version="0.1.0",
    description="Describes selected UI screenshot regions and generates structured prompts for coding agents.",
)
app.state.vlm_backend = None
app.state.inference_lock = asyncio.Lock()
rate_limiter = SlidingWindowRateLimiter(RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_SECONDS)


@app.on_event("startup")
async def startup_event() -> None:
    config = InferenceConfig(
        backend=env_value("BUGSNAP_VLM_BACKEND", "SNAPPROMPT_VLM_BACKEND") or "florence2",
        model_name=env_value("BUGSNAP_VLM_MODEL", "SNAPPROMPT_VLM_MODEL") or "microsoft/Florence-2-base",
        max_new_tokens=env_int("BUGSNAP_MAX_NEW_TOKENS", 200, "SNAPPROMPT_MAX_NEW_TOKENS"),
    )
    app.state.vlm_backend = load_backend(config)
    LOGGER.info("Loaded backend: %s", app.state.vlm_backend.model_name)


@app.middleware("http")
async def request_size_guard(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={"detail": f"Request exceeds {MAX_REQUEST_MB}MB limit."},
                )
        except ValueError:
            LOGGER.warning("Invalid content-length header: %r", content_length)

    return await call_next(request)


async def enforce_rate_limit(request: Request) -> None:
    caller = request.client.host if request.client else "unknown"
    if not rate_limiter.allow(caller):
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded ({RATE_LIMIT_PER_MINUTE} requests / minute).",
        )


@app.get("/health")
async def health() -> dict[str, str]:
    backend = app.state.vlm_backend
    model_name = backend.model_name if backend else "uninitialized"
    return {"status": "ok", "backend": model_name}


@app.post(
    "/describe",
    response_model=DescribeResponseModel,
    dependencies=[Depends(enforce_rate_limit)],
)
async def describe(
    image: UploadFile | None = File(default=None),
    image_base64: str | None = Form(default=None),
    mode: PromptMode = Form(default="ui_bug_fix"),
    page_url: str | None = Form(default=None),
    viewport_width: int = Form(default=0),
    viewport_height: int = Form(default=0),
) -> DescribeResponseModel:
    if image is None and image_base64 is None:
        raise HTTPException(status_code=400, detail="Provide either multipart image or image_base64.")

    if image is not None:
        payload = await image.read()
    else:
        assert image_base64 is not None
        payload = decode_base64_image(image_base64)

    pil_image = image_from_bytes(payload)

    backend: VisionLanguageBackend | None = app.state.vlm_backend
    if backend is None:
        raise HTTPException(status_code=503, detail="Model backend is not available.")

    try:
        async with app.state.inference_lock:
            caption = await run_in_threadpool(backend.describe, pil_image)
    except HTTPException:
        raise
    except Exception as error:
        LOGGER.exception("Inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {error}") from error

    summary, prompt_short, prompt_verbose, elements, issues = build_prompts(
        mode=mode,
        page_url=page_url,
        viewport_width=max(0, viewport_width),
        viewport_height=max(0, viewport_height),
        caption=caption,
    )

    return DescribeResponseModel(
        ui_summary=summary,
        detected_elements=elements,
        suspected_issues=issues,
        prompt_short=prompt_short,
        prompt_verbose=prompt_verbose,
    )
