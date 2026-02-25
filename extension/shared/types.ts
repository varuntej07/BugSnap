export type PromptMode = "fix_this" | "build_this";

export type PromptVerbosity = "short" | "verbose";

export type DetectedElementType = "button" | "input" | "modal" | "nav" | "card" | "table" | "text";

export type BugSnapErrorCode =
  | "CAPTURE_RESTRICTED_PAGE"
  | "SERVER_UNREACHABLE"
  | "REQUEST_TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "MODEL_BACKEND_DEGRADED"
  | "MODEL_PROVIDER_ERROR"
  | "INVALID_RESPONSE_SCHEMA"
  | "UNEXPECTED_INTERNAL_ERROR"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID";

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
  ok?: boolean;
  request_id?: string;
  backend_name?: string;
  degraded?: boolean;
  ui_summary: string;
  detected_elements: DetectedElement[];
  suspected_issues: string[];
  prompt_short: string;
  prompt_verbose: string;
}

export interface BugSnapError {
  ok: false;
  error_code: BugSnapErrorCode;
  user_message: string;
  dev_message: string;
  request_id: string;
  retryable: boolean;
}

export interface PersistedResult {
  created_at: string;
  page_url?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  response: DescribeResponse;
}

export interface PersistedError {
  created_at: string;
  error_code: BugSnapErrorCode;
  user_message: string;
  dev_message: string;
  request_id: string;
  retryable: boolean;
}

export interface ExtensionSettings {
  serverUrl: string;
  mode: PromptMode;
  verbosity: PromptVerbosity;
  authToken: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: "https://bug-snap-2kgx.vercel.app",
  mode: "fix_this",
  verbosity: "short",
  authToken: ""
};

export const STORAGE_KEYS = {
  settings: "settings",
  lastResult: "lastResult",
  lastError: "lastError",
  pendingCapture: "pendingCapture"
} as const;

export interface StartCaptureMessage {
  type: "START_CAPTURE";
  mode?: PromptMode;
}

export interface PendingCapture {
  created_at: string;
  page_url?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  screenshot_data_url: string;
}

export interface SaveResultMessage {
  type: "SAVE_RESULT";
  result: PersistedResult;
}

export interface CaptureFailedMessage {
  type: "CAPTURE_FAILED";
  error: string;
}

export interface OverlaySelectionMessage {
  type: "OVERLAY_SELECTION";
  rect: CropRect;
  devicePixelRatio: number;
}

export interface OverlayCancelMessage {
  type: "OVERLAY_CANCEL";
}

export interface InjectOverlayMessage {
  type: "INJECT_OVERLAY";
  screenshotDataUrl: string;
}

export interface OverlayAnalyzingMessage {
  type: "OVERLAY_ANALYZING";
}

export interface OverlayDoneMessage {
  type: "OVERLAY_DONE";
}

export type RuntimeMessage =
  | StartCaptureMessage
  | SaveResultMessage
  | CaptureFailedMessage
  | OverlaySelectionMessage
  | OverlayCancelMessage
  | InjectOverlayMessage
  | OverlayAnalyzingMessage
  | OverlayDoneMessage;
