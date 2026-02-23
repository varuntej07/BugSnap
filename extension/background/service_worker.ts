import { describeSelection } from "@shared/httpClient";
import { buildStructuredPrompt } from "@shared/promptTemplates";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type CaptureFailedMessage,
  type CropRect,
  type ExtensionSettings,
  type OverlayCancelMessage,
  type OverlaySelectionMessage,
  type PendingCapture,
  type PersistedResult,
  type PromptMode,
  type RuntimeMessage,
  type SaveResultMessage,
  type StartCaptureMessage,
  type ViewportSize
} from "@shared/types";

// --- Service worker-compatible image crop using OffscreenCanvas ---

async function cropDataUrlToBlob(dataUrl: string, rect: CropRect): Promise<Blob> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, rect.x, rect.y, rect.width, rect.height);
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create OffscreenCanvas 2d context.");
  }
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
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
  return {
    ...DEFAULT_SETTINGS,
    ...raw
  };
}

async function storeError(error: string): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.lastError]: error
  });
}

async function clearError(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.lastError);
}

async function persistResult(result: PersistedResult): Promise<void> {
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

function toErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("Permission denied") || text.includes("Cannot capture visible tab")) {
    return "Chrome blocked screenshot capture for the current tab. Switch to the app/site tab and try again.";
  }
  if (text.includes("No window with id")) {
    return "Could not resolve the browser window for capture.";
  }
  if (text.includes("Tabs cannot be edited right now")) {
    return "The tab is still loading. Wait a moment and retry capture.";
  }
  return text || "Could not start capture.";
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

// --- In-page capture flow ---

async function startInPageCapture(modeOverride?: PromptMode): Promise<void> {
  const settings = await getSettings();
  const mode = modeOverride ?? settings.mode;
  const tab = await getActiveTab();

  if (!tab.id || typeof tab.windowId !== "number") {
    throw new Error("Could not resolve browser window for capture.");
  }

  // Check for restricted pages
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      "Cannot capture this page (browser internal pages are restricted). Navigate to a website and try again."
    );
  }

  // Capture screenshot BEFORE injecting overlay
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  // Store pending state
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

  // Try to inject content script for in-page overlay
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/overlay.js"],
    });
  } catch (injectError) {
    // Fallback to Capture Studio tab if injection fails
    console.warn("Content script injection failed, falling back to Capture Studio:", injectError);
    pendingScreenshot = null;
    await startCaptureStudioFallback(mode, screenshotDataUrl, tab);
  }
}

async function startCaptureStudioFallback(
  mode: PromptMode,
  screenshotDataUrl: string,
  tab: chrome.tabs.Tab
): Promise<void> {
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
  if (!pendingScreenshot) {
    await storeError("No pending capture found. Please try again.");
    return;
  }

  const { dataUrl, pageUrl, viewport, mode, tabId } = pendingScreenshot;
  const settings = await getSettings();

  try {
    // Scale selection from viewport coordinates to actual image pixels
    // The screenshot is at device pixel ratio scale
    const imageRect: CropRect = {
      x: Math.round(selectionRect.x * devicePixelRatio),
      y: Math.round(selectionRect.y * devicePixelRatio),
      width: Math.round(selectionRect.width * devicePixelRatio),
      height: Math.round(selectionRect.height * devicePixelRatio),
    };

    const croppedBlob = await cropDataUrlToBlob(dataUrl, imageRect);

    const serverResponse = await describeSelection({
      image: croppedBlob,
      pageUrl,
      viewport: viewport.width > 0 && viewport.height > 0 ? viewport : { width: 1920, height: 1080 },
      mode,
      serverUrl: settings.serverUrl,
      authToken: settings.authToken || undefined,
    });

    // Build fallback prompt if server prompts are empty
    const fallbackPrompt = buildStructuredPrompt({
      pageUrl,
      viewport,
      mode,
      uiSummary: serverResponse.ui_summary,
      detectedElements: serverResponse.detected_elements,
      suspectedIssues: serverResponse.suspected_issues,
    });

    const response = {
      ...serverResponse,
      prompt_short: serverResponse.prompt_short?.trim() ? serverResponse.prompt_short : fallbackPrompt,
      prompt_verbose: serverResponse.prompt_verbose?.trim() ? serverResponse.prompt_verbose : fallbackPrompt,
    };

    const persistedResult: PersistedResult = {
      created_at: new Date().toISOString(),
      page_url: pageUrl,
      viewport,
      mode,
      response,
    };

    await persistResult(persistedResult);
    await clearError();

    // Tell overlay to close
    try {
      await chrome.tabs.sendMessage(tabId, { type: "OVERLAY_DONE" });
    } catch {
      // Tab may have closed
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : "Analysis failed.";
    await storeError(text);

    // Tell overlay to close
    try {
      await chrome.tabs.sendMessage(tabId, { type: "OVERLAY_DONE" });
    } catch {
      // Tab may have closed
    }
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
    const selMsg = message as OverlaySelectionMessage;
    void handleOverlaySelection(selMsg.rect, selMsg.devicePixelRatio, sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OVERLAY_CANCEL") {
    pendingScreenshot = null;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SAVE_RESULT") {
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
