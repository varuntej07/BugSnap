import type { BugSnapError, BugSnapErrorCode, DescribeResponse, PromptMode, ViewportSize } from "./types";

const LOG_PREFIX = "[BugSnap:HTTP]";

interface DescribeSelectionRequest {
  image: Blob;
  pageUrl?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  serverUrl?: string;
  authToken?: string;
  timeoutMs?: number;
}

export class BugSnapApiError extends Error {
  public readonly errorCode: BugSnapErrorCode;
  public readonly userMessage: string;
  public readonly devMessage: string;
  public readonly requestId: string;
  public readonly retryable: boolean;

  constructor(error: BugSnapError) {
    super(error.user_message);
    this.name = "BugSnapApiError";
    this.errorCode = error.error_code;
    this.userMessage = error.user_message;
    this.devMessage = error.dev_message;
    this.requestId = error.request_id;
    this.retryable = error.retryable;
  }
}

function normalizeServerUrl(rawUrl?: string): string {
  const fallback = "https://bug-snap-2kgx.vercel.app";
  const value = (rawUrl ?? fallback).trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isStructuredError(payload: unknown): payload is BugSnapError {
  if (!payload || typeof payload !== "object") return false;
  const data = payload as Record<string, unknown>;
  return data.ok === false && typeof data.error_code === "string" && typeof data.user_message === "string";
}

function assertDescribeResponse(payload: unknown): DescribeResponse {
  const data = payload as DescribeResponse;

  if (!data || typeof data !== "object") {
    throw new Error("Server returned an invalid JSON payload.");
  }

  if (
    typeof data.ui_summary !== "string" ||
    !Array.isArray(data.detected_elements) ||
    !Array.isArray(data.suspected_issues) ||
    typeof data.prompt_short !== "string" ||
    typeof data.prompt_verbose !== "string"
  ) {
    throw new Error("Server response is missing expected fields.");
  }

  return data;
}

function makeLocalError(
  errorCode: BugSnapErrorCode,
  userMessage: string,
  devMessage: string,
  retryable: boolean
): BugSnapApiError {
  return new BugSnapApiError({
    ok: false,
    error_code: errorCode,
    user_message: userMessage,
    dev_message: devMessage,
    request_id: `local_${Date.now().toString(36)}`,
    retryable,
  });
}

export async function checkHealth(serverUrl?: string, authToken?: string): Promise<{ ok: boolean; backend: string; degraded: boolean }> {
  const endpoint = `${normalizeServerUrl(serverUrl)}/health`;
  console.log(LOG_PREFIX, "Health check →", endpoint);
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      console.warn(LOG_PREFIX, "Health check failed, status:", response.status);
      return { ok: false, backend: "unknown", degraded: true };
    }
    const data = (await response.json()) as Record<string, unknown>;
    console.log(LOG_PREFIX, "Health check ←", data);
    return {
      ok: true,
      backend: (data.backend as string) ?? "unknown",
      degraded: (data.degraded as boolean) ?? false,
    };
  } catch (error) {
    console.error(LOG_PREFIX, "Health check unreachable:", error);
    return { ok: false, backend: "unreachable", degraded: true };
  }
}

export async function describeSelection(request: DescribeSelectionRequest): Promise<DescribeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 90_000);
  const endpoint = `${normalizeServerUrl(request.serverUrl)}/describe`;

  const formData = new FormData();
  formData.append("image", request.image, "selection.png");
  formData.append("mode", request.mode);
  formData.append("viewport_width", `${request.viewport.width}`);
  formData.append("viewport_height", `${request.viewport.height}`);

  if (request.pageUrl) {
    formData.append("page_url", request.pageUrl);
  }

  const headers: Record<string, string> = {};
  if (request.authToken) {
    headers["Authorization"] = `Bearer ${request.authToken}`;
  }

  console.log(LOG_PREFIX, "POST →", endpoint, { mode: request.mode, imageSize: request.image.size, viewport: request.viewport });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
      signal: controller.signal,
      headers,
    });

    console.log(LOG_PREFIX, "POST ← status:", response.status);

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        const textBody = await response.text().catch(() => "");
        throw makeLocalError(
          "UNEXPECTED_INTERNAL_ERROR",
          `Server error (${response.status}). Please try again.`,
          `Non-JSON response: ${textBody || "empty body"}`,
          response.status >= 500
        );
      }

      if (isStructuredError(errorBody)) {
        throw new BugSnapApiError(errorBody);
      }

      const detail = (errorBody as Record<string, unknown>)?.detail;
      if (detail && typeof detail === "object" && isStructuredError(detail)) {
        throw new BugSnapApiError(detail);
      }

      throw makeLocalError(
        response.status === 429 ? "RATE_LIMITED" :
        response.status === 413 ? "PAYLOAD_TOO_LARGE" :
        response.status === 401 || response.status === 403 ? "AUTH_REQUIRED" :
        response.status >= 500 ? "MODEL_PROVIDER_ERROR" :
        "UNEXPECTED_INTERNAL_ERROR",
        response.status === 429 ? "Too many requests. Wait a moment and try again." :
        response.status === 413 ? "Image is too large. Try a smaller selection." :
        response.status === 401 || response.status === 403 ? "Authentication failed. Check your settings." :
        `Server error (${response.status}). Please try again.`,
        `HTTP ${response.status}: ${JSON.stringify(errorBody)}`,
        response.status >= 500 || response.status === 429
      );
    }

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (jsonError) {
      throw makeLocalError(
        "INVALID_RESPONSE_SCHEMA",
        "Server returned an unreadable response. The server may be misconfigured.",
        `Failed to parse JSON from ${endpoint}: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`,
        true,
      );
    }
    console.log(LOG_PREFIX, "Response payload keys:", Object.keys(payload as object));

    try {
      return assertDescribeResponse(payload);
    } catch (validationError) {
      throw makeLocalError(
        "INVALID_RESPONSE_SCHEMA",
        "Server returned an unexpected response format. The server may need updating.",
        `Validation failed for ${endpoint}: ${validationError instanceof Error ? validationError.message : String(validationError)} — keys: ${Object.keys(payload as object).join(",")}`,
        true,
      );
    }
  } catch (error) {
    if (error instanceof BugSnapApiError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw makeLocalError(
        "REQUEST_TIMEOUT",
        "Analysis timed out. Try selecting a smaller area or check your connection.",
        "Fetch aborted due to timeout.",
        true,
      );
    }
    if (error instanceof TypeError) {
      throw makeLocalError(
        "SERVER_UNREACHABLE",
        "Could not reach BugSnap server. Check your connection and server URL.",
        `Network error for ${endpoint}: ${error.message}`,
        true,
      );
    }
    throw makeLocalError(
      "SERVER_UNREACHABLE",
      "Could not reach BugSnap server. Check your connection and server URL.",
      `Unexpected error for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}
