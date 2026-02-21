import type { DetectedElement, PromptMode, ViewportSize } from "./types";

export interface PromptTemplateInput {
  pageUrl?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  uiSummary: string;
  detectedElements: DetectedElement[];
  suspectedIssues: string[];
}

const MODE_LABELS: Record<PromptMode, string> = {
  ui_bug_fix: "UI Bug Fix",
  ui_polish: "UI Polish",
  implement_like_this: "Implement Like This"
};

const MODE_ACCEPTANCE_CRITERIA: Record<PromptMode, string[]> = {
  ui_bug_fix: [
    "Fix layout bugs without changing unrelated visual behavior.",
    "Ensure no overlap, clipping, or horizontal overflow at the current viewport.",
    "Keep typography and spacing internally consistent."
  ],
  ui_polish: [
    "Improve visual rhythm, spacing consistency, and typographic hierarchy.",
    "Preserve interaction behavior while improving readability.",
    "Increase visual clarity for important actions."
  ],
  implement_like_this: [
    "Recreate the selected region closely while following existing design tokens.",
    "Match spacing, alignment, and hierarchy from the described UI.",
    "Keep markup accessible and responsive."
  ]
};

const MODE_HINTS: Record<PromptMode, string[]> = {
  ui_bug_fix: [
    "Inspect parent container constraints (`width`, `max-width`, `min-width`).",
    "Check `display` + `align-items` + `justify-content` combinations for misalignment.",
    "Review `overflow`, `text-overflow`, and line clamping behavior."
  ],
  ui_polish: [
    "Normalize spacing scale and use consistent increments.",
    "Adjust line-height and font-weight for legibility and hierarchy.",
    "Tune contrast and focus states for accessibility."
  ],
  implement_like_this: [
    "Start with layout skeleton (grid/flex), then refine typography and spacing.",
    "Use semantic structure and avoid brittle absolute positioning.",
    "Validate at multiple breakpoints before finalizing."
  ]
};

function formatElements(elements: DetectedElement[]): string {
  if (!elements.length) {
    return "- No specific components were confidently detected.";
  }
  return elements.map((element) => `- ${element.type}: ${element.notes}`).join("\n");
}

function formatIssues(issues: string[]): string {
  if (!issues.length) {
    return "- No strong issue hypothesis detected. Focus on spacing/alignment validation.";
  }
  return issues.map((issue) => `- ${issue}`).join("\n");
}

export function buildStructuredPrompt(input: PromptTemplateInput): string {
  const modeLabel = MODE_LABELS[input.mode];
  const acceptanceCriteria = MODE_ACCEPTANCE_CRITERIA[input.mode].map((criterion) => `- ${criterion}`).join("\n");
  const hints = MODE_HINTS[input.mode].map((hint) => `- ${hint}`).join("\n");

  return [
    `Task Type: ${modeLabel}`,
    "",
    "Context",
    `- URL: ${input.pageUrl ?? "Unavailable"}`,
    `- Viewport: ${input.viewport.width}x${input.viewport.height}`,
    "",
    "What's Visible",
    input.uiSummary,
    "",
    "Detected Elements",
    formatElements(input.detectedElements),
    "",
    "What Seems Wrong",
    formatIssues(input.suspectedIssues),
    "",
    "Desired Outcome (Acceptance Criteria)",
    acceptanceCriteria,
    "",
    "Implementation Hints",
    hints
  ].join("\n");
}
