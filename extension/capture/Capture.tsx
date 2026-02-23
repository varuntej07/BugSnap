import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { cropBase64ToPngBlob, scaleRectToImage } from "@shared/imageCrop";
import { describeSelection, BugSnapApiError } from "@shared/httpClient";
import { buildStructuredPrompt } from "@shared/promptTemplates";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type CropRect,
  type ExtensionSettings,
  type PendingCapture,
  type PersistedResult,
  type PromptVerbosity,
  type RuntimeMessage,
  type ViewportSize
} from "@shared/types";
import "./capture.css";

interface Point {
  x: number;
  y: number;
}

const MIN_SELECTION_SIZE = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeRect(a: Point, b: Point): CropRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

function mergeSettings(raw: unknown): ExtensionSettings {
  const partial = (raw as Partial<ExtensionSettings> | undefined) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...partial
  };
}

function isValidViewport(viewport: ViewportSize): boolean {
  return viewport.width > 0 && viewport.height > 0;
}

function formatUrl(url?: string): string {
  if (!url) {
    return "Unavailable";
  }
  if (url.length <= 110) {
    return url;
  }
  return `${url.slice(0, 107)}...`;
}

export function Capture() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null);
  const [status, setStatus] = useState("Loading capture...");
  const [error, setError] = useState("");
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [selectionRect, setSelectionRect] = useState<CropRect | null>(null);
  const [displaySize, setDisplaySize] = useState<ViewportSize | null>(null);
  const [imageSize, setImageSize] = useState<ViewportSize | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<PersistedResult | null>(null);
  const [copyState, setCopyState] = useState("");

  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.settings,
        STORAGE_KEYS.pendingCapture,
        STORAGE_KEYS.lastResult
      ]);

      setSettings(mergeSettings(stored[STORAGE_KEYS.settings]));
      setResult((stored[STORAGE_KEYS.lastResult] as PersistedResult | undefined) ?? null);

      const pending = (stored[STORAGE_KEYS.pendingCapture] as PendingCapture | undefined) ?? null;
      if (!pending) {
        setError("No active capture payload found. Go back to extension popup and click Start Capture.");
        setStatus("");
        return;
      }

      setPendingCapture(pending);
      setStatus("Drag on the screenshot to choose the region you want analyzed.");
    })();
  }, []);

  const activeRect = useMemo(() => {
    if (dragStart && dragPoint) {
      return normalizeRect(dragStart, dragPoint);
    }
    return selectionRect;
  }, [dragPoint, dragStart, selectionRect]);

  const visiblePrompt = useMemo(() => {
    if (!result) {
      return "";
    }
    return settings.verbosity === "short" ? result.response.prompt_short : result.response.prompt_verbose;
  }, [result, settings.verbosity]);

  const promptValid = useMemo(() => {
    return visiblePrompt.trim().length > 0 && visiblePrompt.split(/\s+/).length >= 10;
  }, [visiblePrompt]);

  function updateImageMetrics(): void {
    const image = imageRef.current;
    if (!image) {
      return;
    }
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    setDisplaySize({
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
    setImageSize({
      width: image.naturalWidth,
      height: image.naturalHeight
    });
  }

  useEffect(() => {
    const onResize = () => updateImageMetrics();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function getImagePoint(clientX: number, clientY: number, clampToBounds: boolean): Point | null {
    const image = imageRef.current;
    if (!image) {
      return null;
    }
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const rawX = clientX - rect.left;
    const rawY = clientY - rect.top;

    if (!clampToBounds && (rawX < 0 || rawY < 0 || rawX > rect.width || rawY > rect.height)) {
      return null;
    }

    return {
      x: clamp(rawX, 0, rect.width),
      y: clamp(rawY, 0, rect.height)
    };
  }

  function beginSelection(event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0 || isAnalyzing) {
      return;
    }
    const point = getImagePoint(event.clientX, event.clientY, false);
    if (!point) {
      return;
    }

    setError("");
    setErrorRetryable(false);
    setStatus("Release mouse to lock selection.");
    setDragStart(point);
    setDragPoint(point);
    setSelectionRect(null);
  }

  function updateSelection(event: MouseEvent<HTMLDivElement>): void {
    if (!dragStart) {
      return;
    }
    const point = getImagePoint(event.clientX, event.clientY, true);
    if (!point) {
      return;
    }
    setDragPoint(point);
  }

  function finishSelection(): void {
    if (!dragStart || !dragPoint) {
      return;
    }
    const rect = normalizeRect(dragStart, dragPoint);
    setDragStart(null);
    setDragPoint(null);

    if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
      setSelectionRect(null);
      setError("Selection is too small. Drag a larger rectangle.");
      setStatus("Drag on the screenshot to choose the region you want analyzed.");
      return;
    }

    setSelectionRect(rect);
    setStatus("Selection locked. Click Analyze Selection.");
  }

  async function saveSettings(next: ExtensionSettings): Promise<void> {
    setSettings(next);
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: next
    });
  }

  async function updateVerbosity(verbosity: PromptVerbosity): Promise<void> {
    await saveSettings({
      ...settings,
      verbosity
    });
  }

  async function copyPrompt(): Promise<void> {
    if (!visiblePrompt || !promptValid) {
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

  async function analyzeSelection(): Promise<void> {
    if (!pendingCapture || !selectionRect || !displaySize || !imageSize) {
      setError("Select a region before analyzing.");
      return;
    }

    setError("");
    setErrorRetryable(false);
    setStatus("Analyzing selection...");
    setIsAnalyzing(true);

    try {
      const imageRect = scaleRectToImage(selectionRect, displaySize, imageSize);
      const croppedBlob = await cropBase64ToPngBlob(pendingCapture.screenshot_data_url, imageRect);
      const viewport = isValidViewport(pendingCapture.viewport) ? pendingCapture.viewport : displaySize;

      const serverResponse = await describeSelection({
        image: croppedBlob,
        pageUrl: pendingCapture.page_url,
        viewport,
        mode: pendingCapture.mode,
        serverUrl: settings.serverUrl,
        authToken: settings.authToken || undefined,
      });

      const fallbackPrompt = buildStructuredPrompt({
        pageUrl: pendingCapture.page_url,
        viewport,
        mode: pendingCapture.mode,
        uiSummary: serverResponse.ui_summary,
        detectedElements: serverResponse.detected_elements,
        suspectedIssues: serverResponse.suspected_issues
      });

      const response = {
        ...serverResponse,
        prompt_short: serverResponse.prompt_short?.trim() ? serverResponse.prompt_short : fallbackPrompt,
        prompt_verbose: serverResponse.prompt_verbose?.trim() ? serverResponse.prompt_verbose : fallbackPrompt
      };

      const persistedResult: PersistedResult = {
        created_at: new Date().toISOString(),
        page_url: pendingCapture.page_url,
        viewport,
        mode: pendingCapture.mode,
        response
      };

      const saveResponse = (await chrome.runtime.sendMessage({
        type: "SAVE_RESULT",
        result: persistedResult
      } satisfies RuntimeMessage)) as { ok?: boolean; error?: string } | undefined;

      if (!saveResponse?.ok) {
        throw new Error(saveResponse?.error || "Could not persist generated result.");
      }

      setResult(persistedResult);
      setStatus(
        response.degraded
          ? "Prompt generated (degraded mode - quality may be reduced). Copy it from below."
          : "Prompt generated. Copy it from below."
      );
    } catch (captureError) {
      if (captureError instanceof BugSnapApiError) {
        setError(captureError.userMessage);
        setErrorRetryable(captureError.retryable);
        setStatus(`Analysis failed (${captureError.errorCode}).`);
      } else {
        const text = captureError instanceof Error ? captureError.message : "Failed to analyze selection.";
        setError(text);
        setStatus("Analysis failed.");
      }
      await chrome.runtime.sendMessage({
        type: "CAPTURE_FAILED",
        error: error
      } satisfies RuntimeMessage);
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function closeCaptureTab(): Promise<void> {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
      await chrome.tabs.remove(tab.id);
    }
  }

  return (
    <main className="capture-shell">
      <header className="capture-header">
        <div>
          <h1>BugSnap Capture Studio</h1>
          <p>{pendingCapture ? formatUrl(pendingCapture.page_url) : "Waiting for capture payload..."}</p>
        </div>
        <div className="capture-header__actions">
          <button type="button" className="capture-btn capture-btn--secondary" onClick={() => void closeCaptureTab()}>
            Close
          </button>
          <button
            type="button"
            className="capture-btn capture-btn--primary"
            disabled={!selectionRect || isAnalyzing || !pendingCapture}
            onClick={() => void analyzeSelection()}
          >
            {isAnalyzing ? "Analyzing..." : "Analyze Selection"}
          </button>
        </div>
      </header>

      <section className="capture-controls">
        <label htmlFor="capture-verbosity">Prompt Length</label>
        <select
          id="capture-verbosity"
          value={settings.verbosity}
          onChange={(event) => void updateVerbosity(event.target.value as PromptVerbosity)}
        >
          <option value="short">Short</option>
          <option value="verbose">Verbose</option>
        </select>
      </section>

      {status ? <div className="capture-status">{status}</div> : null}
      {error ? (
        <div className="capture-error">
          <span>{error}</span>
          {errorRetryable && selectionRect ? (
            <button
              type="button"
              className="capture-btn capture-btn--retry"
              onClick={() => void analyzeSelection()}
              disabled={isAnalyzing}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="capture-stage">
        {pendingCapture ? (
          <div
            className="capture-image-wrap"
            onMouseDown={beginSelection}
            onMouseMove={updateSelection}
            onMouseUp={finishSelection}
            onMouseLeave={finishSelection}
            role="presentation"
          >
            <img
              ref={imageRef}
              className="capture-image"
              src={pendingCapture.screenshot_data_url}
              alt="Captured tab screenshot"
              onLoad={updateImageMetrics}
            />
            {activeRect ? (
              <div
                className="capture-selection"
                style={{
                  left: `${activeRect.x}px`,
                  top: `${activeRect.y}px`,
                  width: `${activeRect.width}px`,
                  height: `${activeRect.height}px`
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="capture-empty">Capture payload not found.</div>
        )}
      </section>

      <section className="capture-result">
        <div className="capture-result__header">
          <strong>Generated Prompt</strong>
          <button
            type="button"
            className="capture-btn capture-btn--ghost"
            disabled={!promptValid}
            onClick={() => void copyPrompt()}
            title={!promptValid ? "No valid prompt to copy" : "Copy prompt to clipboard"}
          >
            {copyState || "Copy"}
          </button>
        </div>
        <textarea readOnly rows={14} value={visiblePrompt} placeholder="Analyze a selected region to generate prompt output." />
        {visiblePrompt && !promptValid ? (
          <div className="capture-quality-warning">
            Prompt quality is too low. Try capturing a larger or more distinct region.
          </div>
        ) : null}
      </section>

      {result?.response.request_id ? (
        <div className="capture-request-id">Request ID: {result.response.request_id}</div>
      ) : null}
    </main>
  );
}
