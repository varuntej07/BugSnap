import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type CaptureFailedMessage,
  type ExtensionSettings,
  type OpenOverlayMessage,
  type PersistedResult,
  type PromptMode,
  type RuntimeMessage,
  type SaveResultMessage,
  type StartCaptureMessage
} from "@shared/types";

function isCaptureBlockedUrl(url?: string): boolean {
  if (!url) {
    return true;
  }
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("https://chromewebstore.google.com/") ||
    url.startsWith("https://chrome.google.com/webstore/")
  );
}

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
  await clearError();
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
  if (
    text.includes("Cannot access contents of url") ||
    text.includes("Cannot access a chrome:// URL") ||
    text.includes("The extensions gallery cannot be scripted")
  ) {
    return "This page cannot be captured by Chrome extensions. Open a regular http/https page and try again.";
  }
  if (text.includes("Cannot access contents of the page")) {
    return "BugSnap does not have permission on this tab. Set Site access to 'On all sites', then refresh and retry.";
  }
  if (text.includes("Could not load file") && text.includes("overlay.css")) {
    return "Overlay assets are out of date. Rebuild the extension, then reload it in chrome://extensions.";
  }
  if (text.includes("Failed to fetch dynamically imported module")) {
    return "Overlay module failed to load. Reload the extension and try again.";
  }
  if (text.includes("Could not establish connection. Receiving end does not exist.")) {
    return "Could not inject overlay on this page. Reload the extension and try again.";
  }
  return text || "Could not open overlay on this page.";
}

async function openOverlay(tabId: number, message: OpenOverlayMessage): Promise<void> {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["assets/overlay.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: async () => {
        const moduleUrl = chrome.runtime.getURL("content/overlay.js");
        await import(moduleUrl);
      }
    });
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(toErrorMessage(error));
  }
}

async function startCapture(modeOverride?: PromptMode): Promise<void> {
  const settings = await getSettings();
  const mode = modeOverride ?? settings.mode;
  const tab = await getActiveTab();
  const tabId = tab.id;

  if (isCaptureBlockedUrl(tab.url)) {
    throw new Error("This browser page cannot be captured. Open a regular http/https page.");
  }

  if (typeof tabId !== "number") {
    throw new Error("No active tab found.");
  }

  if (typeof tab.windowId !== "number") {
    throw new Error("Could not resolve browser window for capture.");
  }

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const message: OpenOverlayMessage = {
    type: "OPEN_OVERLAY",
    screenshotDataUrl,
    pageUrl: tab.url,
    mode
  };
  await openOverlay(tabId, message);
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: DEFAULT_SETTINGS
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "start-capture") {
    return;
  }

  void startCapture().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Capture failed.";
    await storeError(message);
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "START_CAPTURE") {
    const startCaptureMessage = message as StartCaptureMessage;
    void startCapture(startCaptureMessage.mode)
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

  if (message.type === "SAVE_RESULT") {
    const saveMessage = message as SaveResultMessage;
    void persistResult(saveMessage.result)
      .then(async () => {
        if (chrome.action.openPopup) {
          try {
            await chrome.action.openPopup();
          } catch {
            // No user gesture available for popup open; ignore.
          }
        }
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
    void storeError(failedMessage.error);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
