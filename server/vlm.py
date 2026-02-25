from __future__ import annotations

import base64
import importlib.util
import io
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image

LOGGER = logging.getLogger("bugsnap.vlm")
FLORENCE_REQUIRED_PACKAGES: tuple[str, ...] = ("einops", "timm")
REQUIREMENTS_PATH = Path(__file__).with_name("requirements.txt")


class BackendDependencyError(RuntimeError):
    """Raised when required backend dependencies are not available."""


def _missing_packages(packages: tuple[str, ...]) -> list[str]:
    return [package for package in packages if importlib.util.find_spec(package) is None]


def _missing_packages_message(missing: list[str]) -> str:
    missing_joined = ", ".join(missing)
    install_missing = f'"{sys.executable}" -m pip install {" ".join(missing)}'
    install_all = f'"{sys.executable}" -m pip install -r "{REQUIREMENTS_PATH}"'
    return (
        f"Missing Florence-2 dependency package(s): {missing_joined}. "
        f"Server interpreter: {sys.executable}\n"
        f"Install missing packages with:\n  {install_missing}\n"
        f"Or install all server dependencies with:\n  {install_all}"
    )


def _validate_transformers_version() -> None:
    from transformers import __version__ as transformers_version

    major = int(transformers_version.split(".", 1)[0])
    if major >= 5:
        raise BackendDependencyError(
            "Florence-2 backend is incompatible with transformers>=5 in this server setup. "
            f"Detected transformers=={transformers_version}. "
            f'Install a 4.x release with: "{sys.executable}" -m pip install "transformers>=4.44,<5.0"'
        )


class VisionLanguageBackend(Protocol):
    model_name: str
    degraded: bool

    def describe(self, image: Image.Image) -> str:
        ...


@dataclass(slots=True)
class InferenceConfig:
    backend: str = "florence2"
    model_name: str = "microsoft/Florence-2-base"
    max_new_tokens: int = 200
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o"


class Florence2Backend:
    degraded = False

    def __init__(self, model_name: str, max_new_tokens: int) -> None:
        _validate_transformers_version()

        missing = _missing_packages(FLORENCE_REQUIRED_PACKAGES)
        if missing:
            raise BackendDependencyError(_missing_packages_message(missing))

        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        self.model_name = model_name
        self.max_new_tokens = max_new_tokens
        self.task_prompt = "<MORE_DETAILED_CAPTION>"

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.float16 if self.device == "cuda" else torch.float32

        LOGGER.info("Loading Florence-2 model '%s' on %s", model_name, self.device)
        self.processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name,
            trust_remote_code=True,
            torch_dtype=self.dtype,
        ).to(self.device)
        self.model.eval()
        self._torch = torch

    def describe(self, image: Image.Image) -> str:
        image_rgb = image.convert("RGB")
        inputs = self.processor(text=self.task_prompt, images=image_rgb, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}

        generation_inputs: dict = {}
        for key in ("input_ids", "attention_mask", "pixel_values"):
            value = inputs.get(key)
            if value is not None:
                generation_inputs[key] = value

        with self._torch.inference_mode():
            generated_ids = self.model.generate(
                **generation_inputs,
                max_new_tokens=self.max_new_tokens,
                num_beams=3,
                do_sample=False,
            )
        generated_text = self.processor.batch_decode(generated_ids, skip_special_tokens=False)[0]

        try:
            parsed = self.processor.post_process_generation(
                generated_text,
                task=self.task_prompt,
                image_size=(image_rgb.width, image_rgb.height),
            )
            if isinstance(parsed, dict):
                caption = parsed.get(self.task_prompt)
                if isinstance(caption, str) and caption.strip():
                    return caption.strip()
        except Exception:
            LOGGER.exception("Florence-2 post-processing failed; using raw decoded text.")

        return (
            generated_text.replace(self.task_prompt, "")
            .replace("</s>", "")
            .replace("<s>", "")
            .strip()
        )


class OpenAIVisionBackend:
    degraded = False

    def __init__(self, api_key: str, model: str = "gpt-4o") -> None:
        self.model_name = model
        self._api_key = api_key

        try:
            from openai import OpenAI
            self._client = OpenAI(api_key=api_key)
            LOGGER.info("OpenAI Vision backend initialized with model '%s'", model)
        except ImportError:
            raise BackendDependencyError(
                "openai package is required for the OpenAI Vision backend. "
                f'Install with: "{sys.executable}" -m pip install openai'
            )

    def describe(self, image: Image.Image) -> str:
        image_rgb = image.convert("RGB")
        LOGGER.info(
            "OpenAI describe() called — image size: %dx%d, model: %s",
            image_rgb.width,
            image_rgb.height,
            self.model_name,
        )

        buffer = io.BytesIO()
        image_rgb.save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        b64_image = base64.b64encode(image_bytes).decode("utf-8")
        LOGGER.info("Image encoded to base64 — PNG size: %d bytes, sending to OpenAI...", len(image_bytes))

        try:
            response = self._client.chat.completions.create(
                model=self.model_name,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a UI and code analysis expert. Analyze the screenshot and respond with a specific, factual description. "
                            "Follow these rules strictly:\n"
                            "1. If you see any error messages, exceptions, stack traces, or console output: "
                            "quote the exact error text verbatim in backticks, then describe where it appears.\n"
                            "2. If you see a UI layout issue: name the exact elements affected and describe the specific problem "
                            "(e.g. 'the nav links are overflowing past the right edge of the container at this viewport width', "
                            "not vague phrases like 'there may be layout issues').\n"
                            "3. If you see a design/styling concern: describe the specific visual inconsistency "
                            "(e.g. 'the heading has 32px margin-bottom but the paragraph below has only 4px margin-top, creating visual imbalance').\n"
                            "4. If this looks like a reference design to implement: describe the layout structure, "
                            "component types, spacing, and visual hierarchy in concrete terms.\n"
                            "Be specific. Use element names, positions, and visible text. Do not hedge — state what you see."
                        ),
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Analyze this screenshot. If there are error messages or stack traces, quote them exactly. Describe what's visually wrong or what you see.",
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{b64_image}",
                                    "detail": "high",
                                },
                            },
                        ],
                    },
                ],
                max_tokens=500,
                temperature=0.1,
            )
        except Exception as exc:
            LOGGER.error("OpenAI API call FAILED — model: %s, error: %s", self.model_name, exc, exc_info=True)
            raise

        usage = getattr(response, "usage", None)
        LOGGER.info(
            "OpenAI API call succeeded — model: %s, prompt_tokens: %s, completion_tokens: %s, total_tokens: %s",
            self.model_name,
            getattr(usage, "prompt_tokens", "?"),
            getattr(usage, "completion_tokens", "?"),
            getattr(usage, "total_tokens", "?"),
        )

        content = response.choices[0].message.content
        if not content or not content.strip():
            LOGGER.warning("OpenAI returned empty caption")
            return "UI region with visible elements. Detailed analysis unavailable."
        LOGGER.info("OpenAI caption received (%d chars)", len(content))
        return content.strip()


class FallbackHeuristicBackend:
    model_name = "fallback-heuristic"
    degraded = True

    def describe(self, image: Image.Image) -> str:
        width, height = image.size
        return (
            f"A cropped website region ({width}x{height}) with likely UI controls, text blocks, and container layout. "
            "Use alignment, spacing, typography, overflow, and layer order checks to identify visible UI issues."
        )


def load_backend(config: InferenceConfig) -> VisionLanguageBackend:
    backend_name = config.backend.strip().lower()

    if backend_name == "openai":
        api_key = config.openai_api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            LOGGER.error("OPENAI_API_KEY is required for OpenAI Vision backend.")
            LOGGER.warning("Falling back to heuristic descriptor.")
            return FallbackHeuristicBackend()
        try:
            return OpenAIVisionBackend(api_key=api_key, model=config.openai_model)
        except BackendDependencyError as error:
            LOGGER.error("%s", error)
            LOGGER.warning("Failed to load OpenAI backend. Falling back to heuristic descriptor.")
            return FallbackHeuristicBackend()
        except Exception:
            LOGGER.exception("Failed to load OpenAI backend. Falling back to heuristic descriptor.")
            return FallbackHeuristicBackend()

    if backend_name == "florence2":
        try:
            return Florence2Backend(model_name=config.model_name, max_new_tokens=config.max_new_tokens)
        except BackendDependencyError as error:
            LOGGER.error("%s", error)
            LOGGER.warning("Failed to load Florence-2 backend. Falling back to heuristic descriptor.")
            return FallbackHeuristicBackend()
        except Exception:
            LOGGER.exception("Failed to load Florence-2 backend. Falling back to heuristic descriptor.")
            return FallbackHeuristicBackend()

    raise ValueError(f"Unsupported backend '{config.backend}'. Use 'florence2' or 'openai'.")
