import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type ExtensionSettings,
  type PersistedResult,
  type PromptMode,
  type PromptVerbosity,
  type RuntimeMessage
} from "@shared/types";
import "./popup.css";

const MODE_OPTIONS: Array<{ value: PromptMode; label: string }> = [
  { value: "ui_bug_fix", label: "UI Bug Fix" },
  { value: "ui_polish", label: "UI Polish" },
  { value: "implement_like_this", label: "Implement Like This" }
];

function mergeSettings(raw: unknown): ExtensionSettings {
  const partial = (raw as Partial<ExtensionSettings> | undefined) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...partial
  };
}

export function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [result, setResult] = useState<PersistedResult | null>(null);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [copyState, setCopyState] = useState<string>("");

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.settings,
        STORAGE_KEYS.lastResult,
        STORAGE_KEYS.lastError
      ]);
      setSettings(mergeSettings(stored[STORAGE_KEYS.settings]));
      setResult((stored[STORAGE_KEYS.lastResult] as PersistedResult | undefined) ?? null);
      setError((stored[STORAGE_KEYS.lastError] as string | undefined) ?? "");
    })();

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: "sync" | "local" | "managed" | "session"
    ) => {
      if (areaName !== "local") {
        return;
      }

      if (changes[STORAGE_KEYS.settings]) {
        setSettings(mergeSettings(changes[STORAGE_KEYS.settings].newValue));
      }

      if (changes[STORAGE_KEYS.lastResult]) {
        setResult((changes[STORAGE_KEYS.lastResult].newValue as PersistedResult | undefined) ?? null);
      }

      if (changes[STORAGE_KEYS.lastError]) {
        setError((changes[STORAGE_KEYS.lastError].newValue as string | undefined) ?? "");
      }
    };

    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  const visiblePrompt = useMemo(() => {
    if (!result) {
      return "";
    }
    return settings.verbosity === "short" ? result.response.prompt_short : result.response.prompt_verbose;
  }, [result, settings.verbosity]);

  async function saveSettings(next: ExtensionSettings): Promise<void> {
    setSettings(next);
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: next
    });
  }

  async function updateMode(mode: PromptMode): Promise<void> {
    await saveSettings({
      ...settings,
      mode
    });
  }

  async function updateVerbosity(verbosity: PromptVerbosity): Promise<void> {
    await saveSettings({
      ...settings,
      verbosity
    });
  }

  async function updateServerUrl(serverUrl: string): Promise<void> {
    await saveSettings({
      ...settings,
      serverUrl
    });
  }

  async function startCapture(): Promise<void> {
    setStatus("Starting capture...");
    setError("");

    try {
      const response = (await chrome.runtime.sendMessage({
        type: "START_CAPTURE",
        mode: settings.mode
      } satisfies RuntimeMessage)) as { ok?: boolean; error?: string };

      if (!response?.ok) {
        throw new Error(response?.error || "Failed to start capture.");
      }

      setStatus("Capture started. Draw a selection on the page.");
      window.close();
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : "Could not start capture.";
      setError(message);
      setStatus("");
    }
  }

  async function copyPrompt(): Promise<void> {
    if (!visiblePrompt) {
      return;
    }

    try {
      await navigator.clipboard.writeText(visiblePrompt);
      setCopyState("Copied");
      setTimeout(() => setCopyState(""), 1500);
    } catch {
      setCopyState("Copy failed");
      setTimeout(() => setCopyState(""), 2000);
    }
  }

  return (
    <div className="popup-shell">
      <header className="popup-header">
        <h1>BugSnap</h1>
        <button type="button" className="start-button" onClick={() => void startCapture()}>
          Start Capture
        </button>
      </header>

      <section className="popup-section">
        <label htmlFor="mode-select">Prompt Type</label>
        <select id="mode-select" value={settings.mode} onChange={(event) => void updateMode(event.target.value as PromptMode)}>
          {MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </section>

      <section className="popup-section">
        <label htmlFor="server-url">Local Server URL</label>
        <input
          id="server-url"
          type="text"
          value={settings.serverUrl}
          onChange={(event) => void updateServerUrl(event.target.value)}
          placeholder="http://127.0.0.1:8000"
        />
      </section>

      <section className="popup-section">
        <label htmlFor="verbosity-select">Prompt Length</label>
        <select
          id="verbosity-select"
          value={settings.verbosity}
          onChange={(event) => void updateVerbosity(event.target.value as PromptVerbosity)}
        >
          <option value="short">Short</option>
          <option value="verbose">Verbose</option>
        </select>
      </section>

      {status ? <div className="popup-status">{status}</div> : null}
      {error ? <div className="popup-error">{error}</div> : null}

      <section className="popup-section popup-section--result">
        <div className="result-header">
          <strong>Generated Prompt</strong>
          <button type="button" className="copy-button" disabled={!visiblePrompt} onClick={() => void copyPrompt()}>
            {copyState || "Copy"}
          </button>
        </div>
        <textarea readOnly value={visiblePrompt} placeholder="Run a capture to generate a prompt." rows={14} />
      </section>

      {result ? (
        <section className="popup-section popup-section--meta">
          <div>Generated: {new Date(result.created_at).toLocaleString()}</div>
          <div>URL: {result.page_url ?? "Unavailable"}</div>
          <div>
            Viewport: {result.viewport.width}x{result.viewport.height}
          </div>
        </section>
      ) : null}
    </div>
  );
}
