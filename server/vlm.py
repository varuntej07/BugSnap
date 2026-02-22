from __future__ import annotations

import importlib.util
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import torch
from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor
from transformers import __version__ as transformers_version

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
    major = int(transformers_version.split(".", 1)[0])
    if major >= 5:
        raise BackendDependencyError(
            "Florence-2 backend is incompatible with transformers>=5 in this server setup. "
            f"Detected transformers=={transformers_version}. "
            f'Install a 4.x release with: "{sys.executable}" -m pip install "transformers>=4.44,<5.0"'
        )


class VisionLanguageBackend(Protocol):
    model_name: str

    def describe(self, image: Image.Image) -> str:
        ...


@dataclass(slots=True)
class InferenceConfig:
    backend: str = "florence2"
    model_name: str = "microsoft/Florence-2-base"
    max_new_tokens: int = 200


class Florence2Backend:
    def __init__(self, model_name: str, max_new_tokens: int) -> None:
        _validate_transformers_version()

        missing = _missing_packages(FLORENCE_REQUIRED_PACKAGES)
        if missing:
            raise BackendDependencyError(_missing_packages_message(missing))

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

    @torch.inference_mode()
    def describe(self, image: Image.Image) -> str:
        image_rgb = image.convert("RGB")
        inputs = self.processor(text=self.task_prompt, images=image_rgb, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}

        generation_inputs: dict[str, torch.Tensor] = {}
        for key in ("input_ids", "attention_mask", "pixel_values"):
            value = inputs.get(key)
            if value is not None:
                generation_inputs[key] = value

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
        except Exception:  # pragma: no cover - parser support varies by model revision.
            LOGGER.exception("Florence-2 post-processing failed; using raw decoded text.")

        return (
            generated_text.replace(self.task_prompt, "")
            .replace("</s>", "")
            .replace("<s>", "")
            .strip()
        )


class FallbackHeuristicBackend:
    model_name = "fallback-heuristic"

    def describe(self, image: Image.Image) -> str:
        width, height = image.size
        return (
            f"A cropped website region ({width}x{height}) with likely UI controls, text blocks, and container layout. "
            "Use alignment, spacing, typography, overflow, and layer order checks to identify visible UI issues."
        )


def load_backend(config: InferenceConfig) -> VisionLanguageBackend:
    backend_name = config.backend.strip().lower()

    if backend_name != "florence2":
        raise ValueError(f"Unsupported backend '{config.backend}'. Use 'florence2'.")

    try:
        return Florence2Backend(model_name=config.model_name, max_new_tokens=config.max_new_tokens)
    except BackendDependencyError as error:
        LOGGER.error("%s", error)
        LOGGER.warning("Failed to load Florence-2 backend. Falling back to heuristic descriptor.")
        return FallbackHeuristicBackend()
    except Exception:
        LOGGER.exception("Failed to load Florence-2 backend. Falling back to heuristic descriptor.")
        return FallbackHeuristicBackend()
