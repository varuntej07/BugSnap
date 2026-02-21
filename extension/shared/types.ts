export type PromptMode = "ui_bug_fix" | "ui_polish" | "implement_like_this";

export type PromptVerbosity = "short" | "verbose";

export type DetectedElementType = "button" | "input" | "modal" | "nav" | "card" | "table" | "text";

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedElement {
  type: DetectedElementType;
  notes: string;
}

export interface DescribeResponse {
  ui_summary: string;
  detected_elements: DetectedElement[];
  suspected_issues: string[];
  prompt_short: string;
  prompt_verbose: string;
}

export interface PersistedResult {
  created_at: string;
  page_url?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  response: DescribeResponse;
}

export interface ExtensionSettings {
  serverUrl: string;
  mode: PromptMode;
  verbosity: PromptVerbosity;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "http://127.0.0.1:8000",
  mode: "ui_bug_fix",
  verbosity: "short"
};

export const STORAGE_KEYS = {
  settings: "settings",
  lastResult: "lastResult",
  lastError: "lastError"
} as const;

export interface StartCaptureMessage {
  type: "START_CAPTURE";
  mode?: PromptMode;
}

export interface OpenOverlayMessage {
  type: "OPEN_OVERLAY";
  screenshotDataUrl: string;
  pageUrl?: string;
  mode: PromptMode;
}

export interface SaveResultMessage {
  type: "SAVE_RESULT";
  result: PersistedResult;
}

export interface CaptureFailedMessage {
  type: "CAPTURE_FAILED";
  error: string;
}

export type RuntimeMessage = StartCaptureMessage | OpenOverlayMessage | SaveResultMessage | CaptureFailedMessage;
