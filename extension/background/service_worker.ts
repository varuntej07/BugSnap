import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type CaptureFailedMessage,
  type ExtensionSettings,
  type PendingCapture,
  type PersistedResult,
  type PromptMode,
  type RuntimeMessage,
  type SaveResultMessage,
  type StartCaptureMessage
} from "@shared/types";

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

async function startCapture(modeOverride?: PromptMode): Promise<void> {
  const settings = await getSettings();
  const mode = modeOverride ?? settings.mode;
  const tab = await getActiveTab();

  if (typeof tab.windowId !== "number") {
    throw new Error("Could not resolve browser window for capture.");
  }

  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const pendingCapture: PendingCapture = {
      created_at: new Date().toISOString(),
      page_url: tab.url,
      viewport: {
        width: typeof tab.width === "number" ? tab.width : 0,
        height: typeof tab.height === "number" ? tab.height : 0
      },
      mode,
      screenshot_data_url: screenshotDataUrl
    };

    await chrome.storage.local.set({
      [STORAGE_KEYS.pendingCapture]: pendingCapture
    });

    await chrome.tabs.create({
      url: chrome.runtime.getURL("capture/index.html"),
      active: true
    });
  } catch (error) {
    throw new Error(toErrorMessage(error));
  }
}

async function clearPendingCapture(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.pendingCapture);
}

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
    void Promise.all([storeError(failedMessage.error), clearPendingCapture()]);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
