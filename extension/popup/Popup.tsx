import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type ExtensionSettings,
  type PersistedResult,
  type PersistedError,
  type PromptMode,
  type PromptVerbosity,
  type RuntimeMessage
} from "@shared/types";
import { checkHealth } from "@shared/httpClient";
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
  const [backendInfo, setBackendInfo] = useState<{ backend: string; degraded: boolean } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.settings,
        STORAGE_KEYS.lastResult,
        STORAGE_KEYS.lastError
      ]);
      const loadedSettings = mergeSettings(stored[STORAGE_KEYS.settings]);
      setSettings(loadedSettings);
      setResult((stored[STORAGE_KEYS.lastResult] as PersistedResult | undefined) ?? null);
      setError((stored[STORAGE_KEYS.lastError] as string | undefined) ?? "");

      // Check backend health
      const health = await checkHealth(loadedSettings.serverUrl, loadedSettings.authToken || undefined);
      setBackendInfo({ backend: health.backend, degraded: health.degraded });
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

  const promptValid = useMemo(() => {
    return visiblePrompt.trim().length > 0 && visiblePrompt.split(/\s+/).length >= 10;
  }, [visiblePrompt]);

  async function saveSettings(next: ExtensionSettings): Promise<void> {
    setSettings(next);
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: next
    });
  }

  async function updateMode(mode: PromptMode): Promise<void> {
    await saveSettings({ ...settings, mode });
  }

  async function updateVerbosity(verbosity: PromptVerbosity): Promise<void> {
    await saveSettings({ ...settings, verbosity });
  }

  async function updateServerUrl(serverUrl: string): Promise<void> {
    await saveSettings({ ...settings, serverUrl });
  }

  async function updateAuthToken(authToken: string): Promise<void> {
    await saveSettings({ ...settings, authToken });
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

      setStatus("Select a region on the page to analyze.");
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
        <div className="popup-header__left">
          <h1>BugSnap</h1>
          {backendInfo ? (
            <span className={`backend-badge ${backendInfo.degraded ? "backend-badge--degraded" : "backend-badge--ok"}`}>
              {backendInfo.degraded ? "Degraded" : backendInfo.backend === "unreachable" ? "Offline" : "Connected"}
            </span>
          ) : null}
        </div>
        <button type="button" className="start-button" onClick={() => void startCapture()}>
          Start Capture
        </button>
      </header>

      {backendInfo?.degraded ? (
        <div className="popup-warning">
          Analysis quality may be reduced. The server is running in fallback mode.
          {backendInfo.backend === "unreachable" ? " Check your server URL and connection." : ""}
        </div>
      ) : null}

      {result?.response?.degraded ? (
        <div className="popup-warning">
          Last result was generated in degraded mode. Prompt quality may be lower than usual.
        </div>
      ) : null}

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

      <button
        type="button"
        className="toggle-advanced"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? "Hide" : "Show"} Server Settings
      </button>

      {showAdvanced ? (
        <>
          <section className="popup-section">
            <label htmlFor="server-url">Server URL</label>
            <input
              id="server-url"
              type="text"
              value={settings.serverUrl}
              onChange={(event) => void updateServerUrl(event.target.value)}
              placeholder="https://your-project.vercel.app"
            />
          </section>

          <section className="popup-section">
            <label htmlFor="auth-token">Auth Token (optional)</label>
            <input
              id="auth-token"
              type="password"
              value={settings.authToken}
              onChange={(event) => void updateAuthToken(event.target.value)}
              placeholder="Leave empty if not required"
            />
          </section>
        </>
      ) : null}

      {status ? <div className="popup-status">{status}</div> : null}
      {error ? (
        <div className="popup-error">
          {error}
        </div>
      ) : null}

      <section className="popup-section popup-section--result">
        <div className="result-header">
          <strong>Generated Prompt</strong>
          <button
            type="button"
            className="copy-button"
            disabled={!promptValid}
            onClick={() => void copyPrompt()}
            title={!promptValid ? "No valid prompt to copy" : "Copy prompt to clipboard"}
          >
            {copyState || "Copy"}
          </button>
        </div>
        <textarea readOnly value={visiblePrompt} placeholder="Run a capture to generate a prompt." rows={14} />
        {visiblePrompt && !promptValid ? (
          <div className="popup-warning" style={{ marginTop: 4 }}>
            Prompt quality is too low to be useful. Try capturing a larger or different region.
          </div>
        ) : null}
      </section>

      {result ? (
        <section className="popup-section popup-section--meta">
          <div>Generated: {new Date(result.created_at).toLocaleString()}</div>
          <div>URL: {result.page_url ?? "Unavailable"}</div>
          <div>Viewport: {result.viewport.width}x{result.viewport.height}</div>
          {result.response.backend_name ? (
            <div>Backend: {result.response.backend_name}</div>
          ) : null}
          {result.response.request_id ? (
            <div className="request-id">ID: {result.response.request_id}</div>
          ) : null}
        </section>
      ) : null}

      <footer className="popup-footer">
        <span>Your screenshots are processed securely and not stored.</span>
      </footer>
    </div>
  );
}
