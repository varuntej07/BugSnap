from __future__ import annotations

import re
from typing import Literal, TypedDict

ElementType = Literal["button", "input", "modal", "nav", "card", "table", "text"]
PromptMode = Literal["fix_this", "build_this"]
Intent = Literal["error_log", "ui_bug", "design_polish"]


class DetectedElement(TypedDict):
    type: ElementType
    notes: str


# --- Element detection ---

ELEMENT_KEYWORDS: dict[ElementType, tuple[str, ...]] = {
    "button": ("button", "cta", "primary action", "click"),
    "input": ("input", "form", "field", "textbox", "search", "dropdown"),
    "modal": ("modal", "dialog", "popup", "overlay", "drawer"),
    "nav": ("navigation", "navbar", "sidebar", "menu", "tab"),
    "card": ("card", "tile", "panel", "widget"),
    "table": ("table", "row", "column", "grid", "list"),
    "text": ("heading", "title", "label", "paragraph", "text"),
}

# --- Intent detection ---

INTENT_ERROR_KEYWORDS = (
    "error", "exception", "traceback", "stack trace", "stack:", "at line",
    "undefined is not", "cannot read", "typeerror", "referenceerror",
    "syntaxerror", "valueerror", "keyerror", "indexerror", "attributeerror",
    "uncaught", "unhandled", "failed to", "404", "500", "502", "503",
    "fatal", "panic", "null pointer", "segfault", "abort", "console.error",
    "warning:", "error:", "exception:", "err:", "✗", "✕",
)

INTENT_DESIGN_KEYWORDS = (
    "font weight", "typography", "color scheme", "contrast ratio",
    "visual hierarchy", "whitespace", "letter-spacing", "line-height",
    "border-radius", "shadow", "opacity", "aesthetic", "branding",
)

INTENT_BUG_KEYWORDS = (
    "overlap", "overflowing", "overflow", "misalign", "misaligned",
    "clipped", "truncated", "cut off", "shifted", "offset", "broken",
    "z-index", "stacking", "hidden behind", "floating", "out of bounds",
    "not aligned", "inconsistent spacing", "gap", "wrapping incorrectly",
)


def detect_intent(caption: str) -> Intent:
    lowered = caption.lower()
    if any(kw in lowered for kw in INTENT_ERROR_KEYWORDS):
        return "error_log"
    if any(kw in lowered for kw in INTENT_BUG_KEYWORDS):
        return "ui_bug"
    if any(kw in lowered for kw in INTENT_DESIGN_KEYWORDS):
        return "design_polish"
    return "ui_bug"


def extract_error_text(caption: str) -> str | None:
    """Extract the first verbatim error message from the caption (backtick-quoted by GPT-4o)."""
    # Look for backtick-quoted text (GPT-4o quotes error messages this way per our prompt)
    backtick_match = re.search(r"`([^`]{8,})`", caption)
    if backtick_match:
        return backtick_match.group(1).strip()

    # Fallback: look for lines that start with known error prefixes
    for line in caption.splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if any(lower.startswith(prefix) for prefix in ("typeerror:", "referenceerror:", "syntaxerror:", "error:", "uncaught ", "exception:")):
            return stripped

    return None


def detect_elements(summary: str) -> list[DetectedElement]:
    lowered = summary.lower()
    elements: list[DetectedElement] = []
    for element_type, keywords in ELEMENT_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            elements.append({"type": element_type, "notes": f"Detected via textual cues related to {', '.join(keywords[:2])}."})
    if not elements:
        elements.append({"type": "text", "notes": "No strong component clues; text blocks are still visible."})
    return elements[:7]


def infer_issues(caption: str, elements: list[DetectedElement]) -> list[str]:
    """Derive a short list of specific suspected issues from the caption."""
    lowered = caption.lower()
    issues: list[str] = []

    if "overlap" in lowered:
        issues.append("Elements are overlapping — check z-index and position context.")
    if "overflow" in lowered or "overflowing" in lowered:
        issues.append("Content overflows its container — check width constraints and overflow rules.")
    if "truncat" in lowered or "cut off" in lowered or "clipped" in lowered:
        issues.append("Text is being clipped or truncated — check overflow and line-height settings.")
    if "misalign" in lowered or "not aligned" in lowered:
        issues.append("Alignment mismatch — check flex/grid axis and align-items settings.")
    if "spacing" in lowered and ("inconsistent" in lowered or "tight" in lowered or "large" in lowered):
        issues.append("Spacing is inconsistent — normalize gap, padding, or margin to a token scale.")
    if "typography" in lowered or "font" in lowered:
        issues.append("Typography scale or weight appears inconsistent across elements.")

    element_types = {item["type"] for item in elements}
    if "input" in element_types and not issues:
        issues.append("Form controls may have inconsistent padding or label alignment.")
    if "modal" in element_types and not issues:
        issues.append("Modal layering or focus hierarchy may be off.")

    if not issues:
        issues = [
            "Spacing or alignment inconsistency between adjacent elements.",
            "Possible overflow or truncation at this viewport size.",
        ]

    return issues[:5]


# --- Prompt builders ---

def _short_page_ref(page_url: str | None) -> str:
    if not page_url:
        return "this page"
    # Strip protocol and trailing slash for readability
    clean = re.sub(r"^https?://", "", page_url).rstrip("/")
    return clean if len(clean) < 60 else clean[:57] + "..."


def build_short_prompt(
    mode: PromptMode,
    page_url: str | None,
    viewport_width: int,
    viewport_height: int,
    caption: str,
    elements: list[DetectedElement],
    issues: list[str],
) -> str:
    page_ref = _short_page_ref(page_url)
    viewport_str = f"{viewport_width}x{viewport_height}" if viewport_width and viewport_height else ""

    if mode == "build_this":
        prompt = (
            f"I want to implement something that looks like this. "
            f"{caption.strip()} "
            f"Build a component that matches this layout and visual structure"
            f"{f' at {viewport_str} viewport' if viewport_str else ''}. "
            f"Use semantic markup, keep it responsive, and match the spacing and typography shown."
        )
        return prompt.strip()

    # fix_this mode — intent-driven
    intent = detect_intent(caption)

    if intent == "error_log":
        error_text = extract_error_text(caption)
        if error_text:
            prompt = (
                f"I'm getting `{error_text}` on {page_ref}. "
                f"{caption.strip()} "
                f"Fix this without changing unrelated logic."
            )
        else:
            prompt = (
                f"I'm seeing an error on {page_ref}. "
                f"{caption.strip()} "
                f"Fix this without changing unrelated code."
            )
        return prompt.strip()

    if intent == "design_polish":
        issue_hint = issues[0] if issues else "the visual spacing feels inconsistent"
        prompt = (
            f"The UI on {page_ref} looks visually off — {issue_hint.lower().rstrip('.')}. "
            f"{caption.strip()} "
            f"Polish this section to improve visual consistency without touching functionality."
        )
        return prompt.strip()

    # ui_bug (default)
    issue_hint = issues[0] if issues else "there's a layout issue"
    prompt = (
        f"I'm seeing a layout issue on {page_ref}"
        f"{f' at {viewport_str}' if viewport_str else ''}. "
        f"{caption.strip()} "
        f"Fix {issue_hint.lower().rstrip('.')} without touching unrelated components."
    )
    return prompt.strip()


def build_verbose_prompt(
    mode: PromptMode,
    page_url: str | None,
    viewport_width: int,
    viewport_height: int,
    caption: str,
    elements: list[DetectedElement],
    issues: list[str],
) -> str:
    short = build_short_prompt(
        mode=mode,
        page_url=page_url,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        caption=caption,
        elements=elements,
        issues=issues,
    )

    element_names = ", ".join(e["type"] for e in elements) if elements else "unknown"
    issues_block = "\n".join(f"- {i}" for i in issues)

    if mode == "build_this":
        verbose = (
            f"{short}\n\n"
            f"Visible elements: {element_names}.\n"
            f"Implementation notes:\n"
            f"- Rebuild structure first, then apply spacing and typography.\n"
            f"- Use semantic HTML and avoid hard-coded pixel offsets.\n"
            f"- Keep styles component-scoped and responsive."
        )
        return verbose.strip()

    intent = detect_intent(caption)

    if intent == "error_log":
        verbose = (
            f"{short}\n\n"
            f"What I suspect is happening:\n{issues_block}\n\n"
            f"Steps to investigate:\n"
            f"- Check the stack trace for the exact file and line.\n"
            f"- Verify null/undefined checks around the failing call.\n"
            f"- Reproduce in isolation before applying the fix.\n"
            f"- Confirm no related tests break after the change."
        )
        return verbose.strip()

    if intent == "design_polish":
        verbose = (
            f"{short}\n\n"
            f"Visual issues I see:\n{issues_block}\n\n"
            f"What to check:\n"
            f"- Normalize spacing to a consistent token scale (4px/8px grid).\n"
            f"- Verify typography hierarchy: heading vs body size and weight.\n"
            f"- Confirm contrast meets readability standards.\n"
            f"- Test at nearby breakpoints to ensure the fix doesn't regress."
        )
        return verbose.strip()

    # ui_bug
    verbose = (
        f"{short}\n\n"
        f"Affected elements: {element_names}.\n"
        f"Suspected causes:\n{issues_block}\n\n"
        f"What to check:\n"
        f"- Inspect flex/grid axis settings, gap usage, and container constraints.\n"
        f"- Check box-sizing, min/max constraints, and nested width calculations.\n"
        f"- Audit overflow and text-wrapping behavior.\n"
        f"- Test at adjacent viewport widths after the fix."
    )
    return verbose.strip()


# --- Quality guards ---

LOW_QUALITY_SIGNALS = (
    "unable to", "cannot determine", "no visible", "image is blank",
    "cannot analyze", "i'm sorry", "i cannot", "i can't",
)
MINIMUM_CAPTION_WORDS = 8


def word_count(text: str) -> int:
    return len([p for p in text.split() if p.strip()])


def is_low_quality_caption(caption: str) -> bool:
    if not caption or not caption.strip():
        return True
    if word_count(caption) < MINIMUM_CAPTION_WORDS:
        return True
    lowered = caption.lower()
    return any(signal in lowered for signal in LOW_QUALITY_SIGNALS)


def enrich_weak_caption(viewport_width: int, viewport_height: int) -> str:
    return (
        f"A UI region captured from a {viewport_width}x{viewport_height} viewport. "
        "Inspect for alignment inconsistencies between sibling elements, spacing irregularities, "
        "text overflow or truncation, and z-index stacking conflicts."
    )


def summarize_caption(caption: str) -> str:
    cleaned = " ".join(caption.replace("\n", " ").split())
    if not cleaned:
        return "The selected region contains web UI controls and text content."
    parts = cleaned.split(".")
    short = ". ".join(p.strip() for p in parts if p.strip())[:620].strip()
    return short if short.endswith(".") else short + "."


# --- Public API ---

def build_prompts(
    mode: PromptMode,
    page_url: str | None,
    viewport_width: int,
    viewport_height: int,
    caption: str,
) -> tuple[str, str, str, list[DetectedElement], list[str]]:
    if is_low_quality_caption(caption):
        caption = enrich_weak_caption(viewport_width, viewport_height)

    summary = summarize_caption(caption)
    elements = detect_elements(summary)
    issues = infer_issues(summary, elements)

    prompt_short = build_short_prompt(
        mode=mode,
        page_url=page_url,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        caption=caption,
        elements=elements,
        issues=issues,
    )
    prompt_verbose = build_verbose_prompt(
        mode=mode,
        page_url=page_url,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        caption=caption,
        elements=elements,
        issues=issues,
    )

    return summary, prompt_short, prompt_verbose, elements, issues
