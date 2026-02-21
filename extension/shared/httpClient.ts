import type { DescribeResponse, PromptMode, ViewportSize } from "./types";

interface DescribeSelectionRequest {
  image: Blob;
  pageUrl?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  serverUrl?: string;
  timeoutMs?: number;
}

function normalizeServerUrl(rawUrl?: string): string {
  const fallback = "http://127.0.0.1:8000";
  const value = (rawUrl ?? fallback).trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Server error (${response.status}): ${errorBody || "No response body."}`);
    }

    const payload = (await response.json()) as unknown;
    return assertDescribeResponse(payload);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request timed out while waiting for local inference server.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
