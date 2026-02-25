import { describeSelection, BugSnapApiError } from "@shared/httpClient";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type CaptureFailedMessage,
  type CropRect,
  type ExtensionSettings,
  type OverlaySelectionMessage,
  type PendingCapture,
  type PersistedResult,
  type PromptMode,
  type RuntimeMessage,
  type SaveResultMessage,
  type StartCaptureMessage,
  type ViewportSize
} from "@shared/types";

const LOG_PREFIX = "[BugSnap:SW]";

// --- Service worker-compatible image crop using OffscreenCanvas ---

async function cropDataUrlToBlob(dataUrl: string, rect: CropRect): Promise<Blob> {
  console.log(LOG_PREFIX, "Cropping image", { x: rect.x, y: rect.y, w: rect.width, h: rect.height });
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, rect.x, rect.y, rect.width, rect.height);
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create OffscreenCanvas 2d context.");
  }
  ctx.drawImage(bitmap, 0, 0);
  const result = await canvas.convertToBlob({ type: "image/png" });
  console.log(LOG_PREFIX, "Crop complete, blob size:", result.size);
  return result;
}

// --- Pending state for in-page capture flow ---
let pendingScreenshot: {
  dataUrl: string;
  pageUrl?: string;
  viewport: ViewportSize;
  mode: PromptMode;
  tabId: number;
} | null = null;

// --- Settings helpers ---

async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = (stored[STORAGE_KEYS.settings] as Partial<ExtensionSettings> | undefined) ?? {};
  return { ...DEFAULT_SETTINGS, ...raw };
}

async function storeError(error: string): Promise<void> {
  console.error(LOG_PREFIX, "Storing error:", error);
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastError]: error
  });
}

async function clearError(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.lastError);
}

async function persistResult(result: PersistedResult): Promise<void> {
  console.log(LOG_PREFIX, "Persisting result", {
    request_id: result.response.request_id,
    backend: result.response.backend_name,
    degraded: result.response.degraded,
    summary_length: result.response.ui_summary?.length,
    prompt_short_length: result.response.prompt_short?.length,
  });
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastResult]: result
  });
  await chrome.storage.local.remove([STORAGE_KEYS.lastError, STORAGE_KEYS.pendingCapture]);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

function isRestrictedUrl(url?: string): boolean {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome:") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.includes("chrome.google.com/webstore") ||
    url.includes("chromewebstore.google.com")
  );
}

// --- Overlay communication helpers ---

async function closeOverlay(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OVERLAY_DONE" });
    console.log(LOG_PREFIX, "Sent OVERLAY_DONE to tab", tabId);
  } catch {
    console.warn(LOG_PREFIX, "OVERLAY_DONE message failed, force-removing via scripting");
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const el = document.getElementById("bugsnap-capture-overlay");
          if (el) el.remove();
        },
      });
    } catch {
      console.warn(LOG_PREFIX, "Force-remove also failed (tab may be closed)");
    }
  }
}

async function showOverlayError(tabId: number, message: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OVERLAY_ERROR", message });
  } catch {
    // Tab may not be available
  }
}

async function forceRemoveOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById("bugsnap-capture-overlay");
        if (el) el.remove();
      },
    });
  } catch {
    // Tab may not be scriptable
  }
}

// --- In-page capture flow ---

async function startInPageCapture(modeOverride?: PromptMode): Promise<void> {
  const settings = await getSettings();
  const mode = modeOverride ?? settings.mode;
  const tab = await getActiveTab();

  console.log(LOG_PREFIX, "Starting capture", { tabId: tab.id, url: tab.url, mode });

  if (!tab.id || typeof tab.windowId !== "number") {
    throw new Error("Could not resolve browser window for capture.");
  }

  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      "Cannot capture this page (browser internal pages are restricted). Navigate to a website and try again."
    );
  }

  // Force-remove any stale overlay from a previous capture attempt
  await forceRemoveOverlay(tab.id);

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  console.log(LOG_PREFIX, "Screenshot captured, data URL length:", screenshotDataUrl.length);

  pendingScreenshot = {
    dataUrl: screenshotDataUrl,
    pageUrl: tab.url,
    viewport: {
      width: typeof tab.width === "number" ? tab.width : 0,
      height: typeof tab.height === "number" ? tab.height : 0,
    },
    mode,
    tabId: tab.id,
  };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/overlay.js"],
    });
    console.log(LOG_PREFIX, "Overlay injected into tab", tab.id);
  } catch (injectError) {
    console.warn(LOG_PREFIX, "Content script injection failed, falling back to Capture Studio:", injectError);
    pendingScreenshot = null;
    await startCaptureStudioFallback(mode, screenshotDataUrl, tab);
  }
}

async function startCaptureStudioFallback(
  mode: PromptMode,
  screenshotDataUrl: string,
  tab: chrome.tabs.Tab
): Promise<void> {
  console.log(LOG_PREFIX, "Opening Capture Studio fallback");
  const pendingCapture: PendingCapture = {
    created_at: new Date().toISOString(),
    page_url: tab.url,
    viewport: {
      width: typeof tab.width === "number" ? tab.width : 0,
      height: typeof tab.height === "number" ? tab.height : 0,
    },
    mode,
    screenshot_data_url: screenshotDataUrl,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingCapture]: pendingCapture,
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL("capture/index.html"),
    active: true,
  });
}

// --- Handle overlay selection result ---

async function handleOverlaySelection(
  selectionRect: CropRect,
  devicePixelRatio: number,
  senderTabId?: number
): Promise<void> {
  console.log(LOG_PREFIX, "handleOverlaySelection", { selectionRect, devicePixelRatio, senderTabId });

  // Resolve the tab to close the overlay on — prefer pendingScreenshot.tabId, fall back to sender
  const overlayTabId = pendingScreenshot?.tabId ?? senderTabId;

  if (!pendingScreenshot) {
    console.error(LOG_PREFIX, "No pendingScreenshot — service worker likely restarted and lost state");
    const errorMsg = "Capture state was lost (service worker restarted). Please try again.";
    await storeError(errorMsg);
    // MUST close the overlay even without pendingScreenshot
    if (overlayTabId) {
      await showOverlayError(overlayTabId, errorMsg);
      // Brief delay so user can see the error before overlay closes
      await new Promise((r) => setTimeout(r, 2500));
      await closeOverlay(overlayTabId);
    }
    return;
  }

  const { dataUrl, pageUrl, viewport, mode, tabId } = pendingScreenshot;
  const settings = await getSettings();
  console.log(LOG_PREFIX, "Server URL:", settings.serverUrl, "| Mode:", mode, "| Page:", pageUrl);

  try {
    const imageRect: CropRect = {
      x: Math.round(selectionRect.x * devicePixelRatio),
      y: Math.round(selectionRect.y * devicePixelRatio),
      width: Math.round(selectionRect.width * devicePixelRatio),
      height: Math.round(selectionRect.height * devicePixelRatio),
    };

    const croppedBlob = await cropDataUrlToBlob(dataUrl, imageRect);

    console.log(LOG_PREFIX, "Sending to backend:", settings.serverUrl + "/describe");
    const serverResponse = await describeSelection({
      image: croppedBlob,
      pageUrl,
      viewport: viewport.width > 0 && viewport.height > 0 ? viewport : { width: 1920, height: 1080 },
      mode,
      serverUrl: settings.serverUrl,
      authToken: settings.authToken || undefined,
    });
    console.log(LOG_PREFIX, "Backend response received", {
      ok: serverResponse.ok,
      request_id: serverResponse.request_id,
      backend: serverResponse.backend_name,
      degraded: serverResponse.degraded,
      summary_preview: serverResponse.ui_summary?.slice(0, 120),
    });

    const persistedResult: PersistedResult = {
      created_at: new Date().toISOString(),
      page_url: pageUrl,
      viewport,
      mode,
      response: serverResponse,
    };

    await persistResult(persistedResult);
    await clearError();
    console.log(LOG_PREFIX, "Result persisted successfully");
    await closeOverlay(tabId);
  } catch (error) {
    let errorMsg: string;
    if (error instanceof BugSnapApiError) {
      errorMsg = `${error.userMessage} (${error.errorCode})`;
      console.error(LOG_PREFIX, "API error:", error.errorCode, error.userMessage, error.devMessage);
    } else {
      errorMsg = error instanceof Error ? error.message : "Analysis failed.";
      console.error(LOG_PREFIX, "Analysis error:", errorMsg, error);
    }
    await storeError(errorMsg);
    // Show error on overlay before closing
    await showOverlayError(tabId, errorMsg);
    await new Promise((r) => setTimeout(r, 3000));
    await closeOverlay(tabId);
  } finally {
    pendingScreenshot = null;
  }
}

// --- Initialization ---

async function initializeSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: DEFAULT_SETTINGS
    });
  }
  console.log(LOG_PREFIX, "Settings initialized");
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettings();
});

// --- Keyboard shortcut ---

chrome.commands.onCommand.addListener((command) => {
  if (command !== "start-capture") {
    return;
  }

  void startInPageCapture().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Capture failed.";
    await storeError(message);
  });
});

// --- Message router ---

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "START_CAPTURE") {
    console.log(LOG_PREFIX, "Message: START_CAPTURE");
    const startCaptureMessage = message as StartCaptureMessage;
    void startInPageCapture(startCaptureMessage.mode)
      .then(async () => {
        await clearError();
        sendResponse({ ok: true });
      })
      .catch(async (error: unknown) => {
        const text = error instanceof Error ? error.message : "Failed to start capture.";
        await storeError(text);
        sendResponse({ ok: false, error: text });
      });
    return true;
  }

  if (message.type === "OVERLAY_SELECTION") {
    console.log(LOG_PREFIX, "Message: OVERLAY_SELECTION", (message as OverlaySelectionMessage).rect);
    const selMsg = message as OverlaySelectionMessage;
    handleOverlaySelection(selMsg.rect, selMsg.devicePixelRatio, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => {
        const text = err instanceof Error ? err.message : "Unknown error";
        console.error(LOG_PREFIX, "handleOverlaySelection rejected:", text);
        sendResponse({ ok: false, error: text });
      });
    return true;
  }

  if (message.type === "OVERLAY_CANCEL") {
    console.log(LOG_PREFIX, "Message: OVERLAY_CANCEL");
    pendingScreenshot = null;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SAVE_RESULT") {
    console.log(LOG_PREFIX, "Message: SAVE_RESULT");
    const saveMessage = message as SaveResultMessage;
    void persistResult(saveMessage.result)
      .then(async () => {
        sendResponse({ ok: true });
      })
      .catch(async (error: unknown) => {
        const text = error instanceof Error ? error.message : "Failed to persist result.";
        await storeError(text);
        sendResponse({ ok: false, error: text });
      });
    return true;
  }

  if (message.type === "CAPTURE_FAILED") {
    console.log(LOG_PREFIX, "Message: CAPTURE_FAILED", (message as CaptureFailedMessage).error);
    const failedMessage = message as CaptureFailedMessage;
    void Promise.all([
      storeError(failedMessage.error),
      chrome.storage.local.remove(STORAGE_KEYS.pendingCapture),
    ]);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
