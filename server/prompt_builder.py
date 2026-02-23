from __future__ import annotations

from typing import Iterable, Literal, TypedDict

ElementType = Literal["button", "input", "modal", "nav", "card", "table", "text"]
PromptMode = Literal["ui_bug_fix", "ui_polish", "implement_like_this"]


class DetectedElement(TypedDict):
    type: ElementType
    notes: str


ELEMENT_KEYWORDS: dict[ElementType, tuple[str, ...]] = {
    "button": ("button", "cta", "primary action", "secondary action", "click"),
    "input": ("input", "form", "field", "textbox", "search", "dropdown"),
    "modal": ("modal", "dialog", "popup", "overlay", "drawer"),
    "nav": ("navigation", "navbar", "sidebar", "menu", "tab"),
    "card": ("card", "tile", "panel", "widget"),
    "table": ("table", "row", "column", "grid", "list"),
    "text": ("heading", "title", "label", "paragraph", "caption", "text"),
}

MODE_GOALS: dict[PromptMode, str] = {
    "ui_bug_fix": "Fix layout and visual bugs in the selected region without changing unrelated behavior.",
    "ui_polish": "Improve visual polish, hierarchy, and spacing consistency while preserving functionality.",
    "implement_like_this": "Implement the selected region faithfully as a target design reference.",
}

MODE_ACCEPTANCE: dict[PromptMode, list[str]] = {
    "ui_bug_fix": [
        "No clipped text, no overlap, and no horizontal overflow at the given viewport.",
        "Key controls align correctly on both axes and maintain consistent spacing.",
        "Typography scale, line-height, and weight are internally consistent.",
        "Fixes are scoped to relevant components only."
    ],
    "ui_polish": [
        "Spacing follows a coherent scale and improves visual rhythm.",
        "Typography hierarchy is clearer and easier to scan.",
        "Contrast and emphasis improve readability and action clarity.",
        "Layout remains responsive and stable at nearby breakpoints."
    ],
    "implement_like_this": [
        "Component structure, spacing, and alignment match the reference closely.",
        "Interaction states and semantics remain accessible.",
        "Implementation stays maintainable and token-driven.",
        "Layout scales cleanly across desktop and mobile widths."
    ],
}

MODE_HINTS: dict[PromptMode, list[str]] = {
    "ui_bug_fix": [
        "Inspect flex/grid axis settings, gap usage, and container constraints.",
        "Check `box-sizing`, min/max constraints, and nested width calculations.",
        "Audit `overflow`, `line-height`, and text wrapping behavior.",
        "Verify stacking context and `z-index` only where layering is involved."
    ],
    "ui_polish": [
        "Normalize spacing values to a small token scale.",
        "Refine text styles (size, line-height, weight, letter-spacing) per hierarchy level.",
        "Balance white space around controls and groups.",
        "Tune color contrast and interactive affordances."
    ],
    "implement_like_this": [
        "Rebuild structure first, then apply spacing and typography passes.",
        "Use semantic wrappers and avoid brittle absolute offsets.",
        "Implement responsive behavior with flexible tracks and wrapping.",
        "Keep CSS selectors component-scoped and predictable."
    ],
}

DEBUG_CHECKLIST = [
    "Start by reproducing the issue with browser devtools open and inspect computed styles on the selected region.",
    "Identify the nearest layout container controlling flow and dimensions; verify whether it uses flex, grid, block, or absolute positioning.",
    "Compare rendered box sizes with intended sizes and inspect content-box vs border-box behavior.",
    "Validate alignment settings (`align-items`, `justify-content`, `place-items`) relative to the active axis and writing mode.",
    "Review spacing sources (`gap`, `padding`, `margin`) and remove accidental duplicates from parent/child stacks.",
    "Check intrinsic width constraints caused by long text, fixed-width elements, min-content sizing, or unbroken strings.",
    "Inspect text rendering details such as line-height, font fallback, letter spacing, and truncated labels.",
    "Verify overflow rules and ensure clipping is intentional where used (`overflow: hidden`, masks, line clamp).",
    "Audit stacking contexts created by transforms, opacity, or positioned ancestors before adjusting z-index values.",
    "Test hover/focus/active states to confirm visual fixes do not regress interactions.",
    "Evaluate responsiveness at adjacent viewport widths and ensure no new breakpoints are needed for this scope.",
    "After applying fixes, re-measure spacing and alignment to ensure consistency with surrounding UI."
]


def word_count(text: str) -> int:
    return len([piece for piece in text.split() if piece.strip()])


def trim_to_max_words(text: str, max_words: int) -> str:
    words = [piece for piece in text.split() if piece.strip()]
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).strip()


def ensure_min_words(text: str, min_words: int, filler_lines: Iterable[str]) -> str:
    output = text.strip()
    if word_count(output) >= min_words:
        return output

    lines = list(filler_lines)
    index = 0
    while word_count(output) < min_words and index < len(lines):
        output += "\n- " + lines[index]
        index += 1
    return output


def summarize_caption(caption: str) -> str:
    cleaned = " ".join(caption.replace("\n", " ").split())
    if not cleaned:
        return "The selected region contains web UI controls and text content with layout relationships."

    parts = cleaned.split(".")
    short = ". ".join(part.strip() for part in parts if part.strip())[:620].strip()
    if not short.endswith("."):
        short += "."
    return short


def detect_elements(summary: str) -> list[DetectedElement]:
    lowered = summary.lower()
    elements: list[DetectedElement] = []

    for element_type, keywords in ELEMENT_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            elements.append(
                {
                    "type": element_type,
                    "notes": f"Detected via textual cues related to {', '.join(keywords[:2])}."
                }
            )

    if not elements:
        elements.append({"type": "text", "notes": "No strong component clues; text blocks are still visible."})

    return elements[:7]


def infer_issues(summary: str, elements: list[DetectedElement]) -> list[str]:
    lowered = summary.lower()
    issues: list[str] = []

    if "overlap" in lowered or "stack" in lowered:
        issues.append("Potential overlapping layers or stacking order conflict.")
    if "clipped" in lowered or "truncate" in lowered or "cut off" in lowered:
        issues.append("Text may be clipped or truncated due to height/overflow constraints.")
    if "dense" in lowered or "crowded" in lowered:
        issues.append("Spacing may be too tight, reducing readability and visual rhythm.")
    if "misalign" in lowered or "off-center" in lowered:
        issues.append("Likely cross-axis or baseline alignment mismatch.")
    if "small text" in lowered or "low contrast" in lowered:
        issues.append("Typography size/contrast could be harming readability.")

    element_types = {item["type"] for item in elements}
    if "table" in element_types:
        issues.append("Tabular/list region may suffer from column width or overflow instability.")
    if "modal" in element_types:
        issues.append("Modal layering and focus hierarchy may be inconsistent.")
    if "input" in element_types:
        issues.append("Form controls may have inconsistent heights, padding, or label alignment.")

    if not issues:
        issues = [
            "Potential spacing inconsistency between adjacent elements.",
            "Possible alignment mismatch between labels and controls.",
            "Possible overflow/truncation risk at current viewport.",
            "Typography hierarchy may be inconsistent across nearby components."
        ]

    deduped: list[str] = []
    for item in issues:
        if item not in deduped:
            deduped.append(item)
    return deduped[:8]


def _list_lines(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def _elements_lines(elements: list[DetectedElement]) -> str:
    return "\n".join(f"- {element['type']}: {element['notes']}" for element in elements)


def build_short_prompt(
    mode: PromptMode,
    page_url: str | None,
    viewport_width: int,
    viewport_height: int,
    summary: str,
    elements: list[DetectedElement],
    issues: list[str],
) -> str:
    prompt = f"""
Context
- Page URL: {page_url or "Unavailable"}
- Viewport: {viewport_width}x{viewport_height}
- User Goal: {MODE_GOALS[mode]}

What's Visible (Selected Region)
{summary}

Detected Elements
{_elements_lines(elements)}

What Seems Wrong
{_list_lines(issues)}

Desired Outcome (Acceptance Criteria)
{_list_lines(MODE_ACCEPTANCE[mode])}

Implementation Hints (Likely Causes)
{_list_lines(MODE_HINTS[mode])}

Execution Notes
- Provide a targeted code change that addresses the region only.
- Explain root cause briefly before showing updated code.
- Include validation checks for alignment, spacing, overflow, and text readability after the fix.
""".strip()

    prompt = ensure_min_words(prompt, 250, DEBUG_CHECKLIST)
    return trim_to_max_words(prompt, 400)


def build_verbose_prompt(
    mode: PromptMode,
    page_url: str | None,
    viewport_width: int,
    viewport_height: int,
    summary: str,
    elements: list[DetectedElement],
    issues: list[str],
) -> str:
    details = f"""
Context
- Page URL: {page_url or "Unavailable"}
- Viewport: {viewport_width}x{viewport_height}
- User Goal: {MODE_GOALS[mode]}
- Task Type: {mode}

What's Visible (Selected Region)
{summary}

Detected Elements
{_elements_lines(elements)}

What Seems Wrong (Hypotheses)
{_list_lines(issues)}

Desired Outcome (Acceptance Criteria)
{_list_lines(MODE_ACCEPTANCE[mode])}

Implementation Hints (Likely CSS/Layout Causes)
{_list_lines(MODE_HINTS[mode])}

Detailed Debugging and Implementation Plan
- Start with layout diagnostics: identify which ancestor establishes width and alignment constraints for this region.
- Inspect active display modes (`flex`, `grid`, `block`) and verify whether child alignment rules are applied to the expected axis.
- Measure spacing sources with computed styles and remove duplicated spacing coming from both parent gap and child margin.
- Evaluate text wrapping and truncation by checking line-height, max-width, and overflow policies for headings and labels.
- Check whether intrinsic sizing from long labels, icons, or controls is forcing container growth beyond expected width.
- Validate visual hierarchy: heading vs body text sizes, emphasis levels, and spacing between grouped content.
- Review layer order and clipping behavior where overlays, sticky bars, or positioned children appear near each other.
- Apply the minimum scoped fix first, then retest at nearby viewport widths for regressions.
- Prefer maintainable fixes: semantic wrappers, token-based spacing, and removal of hard-coded pixel offsets where possible.
- Document before/after behavior in concise terms so the change is easy to review.

Verification Checklist
- Confirm no element overlap and no accidental clipping in the selected region.
- Confirm text remains fully readable and baseline alignment is consistent.
- Confirm controls keep consistent heights, padding, and focus ring visibility.
- Confirm no horizontal scroll appears at this viewport.
- Confirm nearby components outside the selected region are visually unchanged.
- Confirm behavior under reduced width remains stable (simple responsive sanity pass).
- Confirm z-index changes do not create new layering regressions.

Expected Output From Coding Agent
- A short root-cause explanation tied to specific DOM/CSS constraints.
- A minimal patch touching only necessary files/components.
- Acceptance criteria checklist with pass/fail notes.
- Any follow-up refactor suggestions separated from the core fix.
""".strip()

    details = ensure_min_words(details, 800, DEBUG_CHECKLIST)
    return trim_to_max_words(details, 1200)


LOW_QUALITY_SIGNALS = [
    "unable to",
    "cannot determine",
    "no visible",
    "image is blank",
    "cannot analyze",
    "i'm sorry",
    "i cannot",
]

MINIMUM_SUMMARY_WORD_COUNT = 8
MINIMUM_PROMPT_WORD_COUNT = 50


def is_low_quality_caption(caption: str) -> bool:
    if not caption or not caption.strip():
        return True
    if word_count(caption) < MINIMUM_SUMMARY_WORD_COUNT:
        return True
    lowered = caption.lower()
    return any(signal in lowered for signal in LOW_QUALITY_SIGNALS)


def enrich_weak_summary(summary: str, viewport_width: int, viewport_height: int) -> str:
    base = summary.strip() if summary.strip() else "A UI region was captured for analysis."
    enrichment = (
        f" The captured area is from a {viewport_width}x{viewport_height} viewport. "
        "Inspect the region for common layout issues: alignment inconsistencies between sibling elements, "
        "spacing irregularities in padding or margins, text overflow or truncation, "
        "and z-index stacking conflicts. Check for button/input sizing consistency and "
        "typography hierarchy (heading vs body text scale)."
    )
    return base + enrichment


def validate_prompt_quality(prompt: str, min_words: int = MINIMUM_PROMPT_WORD_COUNT) -> bool:
    if not prompt or not prompt.strip():
        return False
    return word_count(prompt) >= min_words


def build_prompts(
    mode: PromptMode,
    page_url: str | None,
    viewport_width: int,
    viewport_height: int,
    caption: str,
) -> tuple[str, str, str, list[DetectedElement], list[str]]:
    low_quality = is_low_quality_caption(caption)
    summary = summarize_caption(caption)

    if low_quality:
        summary = enrich_weak_summary(summary, viewport_width, viewport_height)

    elements = detect_elements(summary)
    issues = infer_issues(summary, elements)

    prompt_short = build_short_prompt(
        mode=mode,
        page_url=page_url,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        summary=summary,
        elements=elements,
        issues=issues,
    )
    prompt_verbose = build_verbose_prompt(
        mode=mode,
        page_url=page_url,
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        summary=summary,
        elements=elements,
        issues=issues,
    )

    if not validate_prompt_quality(prompt_short):
        prompt_short = build_short_prompt(
            mode=mode,
            page_url=page_url,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            summary=enrich_weak_summary("", viewport_width, viewport_height),
            elements=elements,
            issues=issues,
        )

    if not validate_prompt_quality(prompt_verbose):
        prompt_verbose = build_verbose_prompt(
            mode=mode,
            page_url=page_url,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            summary=enrich_weak_summary("", viewport_width, viewport_height),
            elements=elements,
            issues=issues,
        )

    return summary, prompt_short, prompt_verbose, elements, issues
