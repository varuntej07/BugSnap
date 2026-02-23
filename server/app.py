from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from prompt_builder import build_prompts
from vlm import InferenceConfig, VisionLanguageBackend, load_backend

LOGGER = logging.getLogger("bugsnap.server")

PromptMode = Literal["ui_bug_fix", "ui_polish", "implement_like_this"]
ElementType = Literal["button", "input", "modal", "nav", "card", "table", "text"]

# --- Error codes ---
ERROR_CODES = {
    "CAPTURE_RESTRICTED_PAGE",
    "SERVER_UNREACHABLE",
    "REQUEST_TIMEOUT",
    "PAYLOAD_TOO_LARGE",
    "RATE_LIMITED",
    "MODEL_BACKEND_DEGRADED",
    "MODEL_PROVIDER_ERROR",
    "INVALID_RESPONSE_SCHEMA",
    "UNEXPECTED_INTERNAL_ERROR",
    "AUTH_REQUIRED",
    "AUTH_INVALID",
}


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
REQUEST_TIMEOUT_SECONDS = env_int("BUGSNAP_REQUEST_TIMEOUT_SECONDS", 60)
Image.MAX_IMAGE_PIXELS = env_int("BUGSNAP_MAX_IMAGE_PIXELS", 40_000_000, "SNAPPROMPT_MAX_IMAGE_PIXELS")

AUTH_TOKEN = env_value("BUGSNAP_AUTH_TOKEN")

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in (env_value("BUGSNAP_ALLOWED_ORIGINS") or "").split(",")
    if origin.strip()
] or ["*"]


def generate_request_id() -> str:
    return f"bgs_{uuid.uuid4().hex[:16]}"


# --- Response Models ---

class DetectedElementModel(BaseModel):
    type: ElementType
    notes: str


class DescribeResponseModel(BaseModel):
    ok: bool = True
    request_id: str
    backend_name: str
    degraded: bool
    ui_summary: str
    detected_elements: list[DetectedElementModel]
    suspected_issues: list[str]
    prompt_short: str
    prompt_verbose: str


class HealthResponseModel(BaseModel):
    ok: bool = True
    status: str
    backend: str
    degraded: bool
    request_id: str


class ErrorResponseModel(BaseModel):
    ok: bool = False
    error_code: str
    user_message: str
    dev_message: str
    request_id: str
    retryable: bool


# --- Rate Limiter ---

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


# --- Helpers ---

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


def make_error_response(
    status_code: int,
    error_code: str,
    user_message: str,
    dev_message: str,
    request_id: str,
    retryable: bool = False,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponseModel(
            error_code=error_code,
            user_message=user_message,
            dev_message=dev_message,
            request_id=request_id,
            retryable=retryable,
        ).model_dump(),
    )


# --- App Setup ---

app = FastAPI(
    title="BugSnap VLM Server",
    version="0.2.0",
    description="Describes selected UI screenshot regions and generates structured prompts for coding agents.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)

app.state.vlm_backend = None
app.state.inference_lock = asyncio.Lock()
rate_limiter = SlidingWindowRateLimiter(RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_SECONDS)


@app.on_event("startup")
async def startup_event() -> None:
    backend_name = env_value("BUGSNAP_VLM_BACKEND", "SNAPPROMPT_VLM_BACKEND") or "openai"
    config = InferenceConfig(
        backend=backend_name,
        model_name=env_value("BUGSNAP_VLM_MODEL", "SNAPPROMPT_VLM_MODEL") or "microsoft/Florence-2-base",
        max_new_tokens=env_int("BUGSNAP_MAX_NEW_TOKENS", 200, "SNAPPROMPT_MAX_NEW_TOKENS"),
        openai_api_key=env_value("OPENAI_API_KEY"),
        openai_model=env_value("BUGSNAP_OPENAI_MODEL") or "gpt-4o",
    )
    app.state.vlm_backend = load_backend(config)
    LOGGER.info("Loaded backend: %s (degraded=%s)", app.state.vlm_backend.model_name, app.state.vlm_backend.degraded)


@app.middleware("http")
async def add_request_id_header(request: Request, call_next):
    request_id = generate_request_id()
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


@app.middleware("http")
async def request_size_guard(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                request_id = getattr(request.state, "request_id", generate_request_id())
                return make_error_response(
                    413,
                    "PAYLOAD_TOO_LARGE",
                    f"Request is too large (max {MAX_REQUEST_MB}MB). Try selecting a smaller region.",
                    f"Content-Length {content_length} exceeds {MAX_REQUEST_BYTES} byte limit.",
                    request_id,
                    retryable=False,
                )
        except ValueError:
            LOGGER.warning("Invalid content-length header: %r", content_length)

    return await call_next(request)


async def verify_auth(request: Request) -> None:
    if not AUTH_TOKEN:
        return
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization header required.")
    token = auth_header[7:].strip()
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid authorization token.")


async def enforce_rate_limit(request: Request) -> None:
    caller = request.client.host if request.client else "unknown"
    if not rate_limiter.allow(caller):
        request_id = getattr(request.state, "request_id", generate_request_id())
        raise HTTPException(
            status_code=429,
            detail=ErrorResponseModel(
                error_code="RATE_LIMITED",
                user_message=f"Too many requests. Please wait a minute and try again.",
                dev_message=f"Rate limit exceeded ({RATE_LIMIT_PER_MINUTE} requests / {RATE_LIMIT_WINDOW_SECONDS}s window).",
                request_id=request_id,
                retryable=True,
            ).model_dump(),
        )


# --- Endpoints ---

@app.get("/health")
async def health(request: Request) -> HealthResponseModel:
    backend = app.state.vlm_backend
    model_name = backend.model_name if backend else "uninitialized"
    degraded = backend.degraded if backend else True
    request_id = getattr(request.state, "request_id", generate_request_id())
    return HealthResponseModel(
        status="ok",
        backend=model_name,
        degraded=degraded,
        request_id=request_id,
    )


@app.post(
    "/describe",
    response_model=DescribeResponseModel,
    dependencies=[Depends(enforce_rate_limit)],
)
async def describe(
    request: Request,
    image: UploadFile | None = File(default=None),
    image_base64: str | None = Form(default=None),
    mode: PromptMode = Form(default="ui_bug_fix"),
    page_url: str | None = Form(default=None),
    viewport_width: int = Form(default=0),
    viewport_height: int = Form(default=0),
) -> DescribeResponseModel | JSONResponse:
    request_id = getattr(request.state, "request_id", generate_request_id())

    if AUTH_TOKEN:
        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer ") or auth_header[7:].strip() != AUTH_TOKEN:
            return make_error_response(
                401,
                "AUTH_REQUIRED",
                "Authentication required. Check your BugSnap settings.",
                "Missing or invalid Bearer token in Authorization header.",
                request_id,
                retryable=False,
            )

    if image is None and image_base64 is None:
        return make_error_response(
            400,
            "INVALID_RESPONSE_SCHEMA",
            "No image provided. Please capture a region first.",
            "Provide either multipart image or image_base64.",
            request_id,
            retryable=False,
        )

    try:
        if image is not None:
            payload = await image.read()
        else:
            assert image_base64 is not None
            payload = decode_base64_image(image_base64)
    except HTTPException as e:
        return make_error_response(
            e.status_code,
            "INVALID_RESPONSE_SCHEMA",
            "The image could not be processed. Try capturing again.",
            str(e.detail),
            request_id,
            retryable=False,
        )

    try:
        pil_image = image_from_bytes(payload)
    except HTTPException as e:
        error_code = "PAYLOAD_TOO_LARGE" if e.status_code == 413 else "INVALID_RESPONSE_SCHEMA"
        user_msg = (
            f"Image is too large (max {MAX_IMAGE_MB}MB). Select a smaller region."
            if e.status_code == 413
            else "The image format is not supported. Try capturing again."
        )
        return make_error_response(
            e.status_code,
            error_code,
            user_msg,
            str(e.detail),
            request_id,
            retryable=False,
        )

    backend: VisionLanguageBackend | None = app.state.vlm_backend
    if backend is None:
        return make_error_response(
            503,
            "MODEL_PROVIDER_ERROR",
            "Analysis service is starting up. Please try again in a moment.",
            "Model backend is not yet initialized.",
            request_id,
            retryable=True,
        )

    try:
        async with app.state.inference_lock:
            caption = await asyncio.wait_for(
                run_in_threadpool(backend.describe, pil_image),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
    except asyncio.TimeoutError:
        return make_error_response(
            504,
            "REQUEST_TIMEOUT",
            "Analysis took too long. Try selecting a smaller region or retry.",
            f"Inference timed out after {REQUEST_TIMEOUT_SECONDS}s.",
            request_id,
            retryable=True,
        )
    except HTTPException:
        raise
    except Exception as error:
        LOGGER.exception("Inference failed (request_id=%s)", request_id)
        return make_error_response(
            500,
            "MODEL_PROVIDER_ERROR",
            "Analysis failed. Please retry. If the issue persists, the service may be temporarily unavailable.",
            f"Inference failed: {error}",
            request_id,
            retryable=True,
        )

    summary, prompt_short, prompt_verbose, elements, issues = build_prompts(
        mode=mode,
        page_url=page_url,
        viewport_width=max(0, viewport_width),
        viewport_height=max(0, viewport_height),
        caption=caption,
    )

    return DescribeResponseModel(
        ok=True,
        request_id=request_id,
        backend_name=backend.model_name,
        degraded=backend.degraded,
        ui_summary=summary,
        detected_elements=elements,
        suspected_issues=issues,
        prompt_short=prompt_short,
        prompt_verbose=prompt_verbose,
    )
