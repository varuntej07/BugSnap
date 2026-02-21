import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cropBase64ToPngBlob, getImageDimensions, scaleRectToImage } from "@shared/imageCrop";
import { describeSelection } from "@shared/httpClient";
import { buildStructuredPrompt } from "@shared/promptTemplates";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type CropRect,
  type ExtensionSettings,
  type OpenOverlayMessage,
  type PersistedResult,
  type PromptMode,
  type RuntimeMessage
} from "@shared/types";
import "./overlay.css";

interface Point {
  x: number;
  y: number;
}

const ROOT_ID = "snapprompt-overlay-root";
const MIN_SELECTION_SIZE = 12;

let appRoot: Root | null = null;
let hostElement: HTMLDivElement | null = null;
let originalHtmlOverflow = "";
let originalBodyOverflow = "";

const MODE_LABELS: Record<PromptMode, string> = {
  ui_bug_fix: "UI Bug Fix",
  ui_polish: "UI Polish",
  implement_like_this: "Implement Like This"
};

function normalizeRect(a: Point, b: Point): CropRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

function restorePageOverflow(): void {
  document.documentElement.style.overflow = originalHtmlOverflow;
  document.body.style.overflow = originalBodyOverflow;
}

function lockPageOverflow(): void {
  originalHtmlOverflow = document.documentElement.style.overflow;
  originalBodyOverflow = document.body.style.overflow;
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
}

function destroyOverlay(): void {
  if (appRoot && hostElement) {
    appRoot.unmount();
    hostElement.remove();
  }

  appRoot = null;
  hostElement = null;
  restorePageOverflow();
}

async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const partial = (stored[STORAGE_KEYS.settings] as Partial<ExtensionSettings> | undefined) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...partial
  };
}

function mountOverlay(message: OpenOverlayMessage): void {
  destroyOverlay();
  lockPageOverflow();

  hostElement = document.createElement("div");
  hostElement.id = ROOT_ID;
  document.documentElement.appendChild(hostElement);

  appRoot = createRoot(hostElement);
  appRoot.render(<OverlayApp message={message} onClose={destroyOverlay} />);
}

export function openOverlay(message: OpenOverlayMessage): void {
  mountOverlay(message);
}

function OverlayApp(props: { message: OpenOverlayMessage; onClose: () => void }) {
  const { message, onClose } = props;
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [selectionRect, setSelectionRect] = useState<CropRect | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [errorText, setErrorText] = useState<string>("");
  const [statusText, setStatusText] = useState<string>("Drag to select a region.");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    void getImageDimensions(message.screenshotDataUrl).then(setImageSize).catch(() => {
      setErrorText("Could not read screenshot dimensions.");
    });
  }, [message.screenshotDataUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  const activeRect = useMemo(() => {
    if (dragStart && dragPoint) {
      return normalizeRect(dragStart, dragPoint);
    }
    return selectionRect;
  }, [dragPoint, dragStart, selectionRect]);

  function beginSelection(event: MouseEvent<HTMLDivElement>): void {
    if (isAnalyzing || event.button !== 0) {
      return;
    }
    setErrorText("");
    setStatusText("Release mouse to lock selection.");
    const point = { x: event.clientX, y: event.clientY };
    setDragStart(point);
    setDragPoint(point);
    setSelectionRect(null);
  }

  function updateSelection(event: MouseEvent<HTMLDivElement>): void {
    if (!dragStart) {
      return;
    }
    setDragPoint({ x: event.clientX, y: event.clientY });
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
      setErrorText("Selection is too small. Drag a larger rectangle.");
      setStatusText("Drag to select a region.");
      return;
    }

    setSelectionRect(rect);
    setStatusText("Selection locked. Click Analyze Selection.");
  }

  async function analyzeSelection(): Promise<void> {
    if (!selectionRect || !imageSize) {
      setErrorText("Create a selection before analyzing.");
      return;
    }

    setErrorText("");
    setStatusText("Analyzing selected region...");
    setIsAnalyzing(true);

    try {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight
      };

      const imageRect = scaleRectToImage(selectionRect, viewport, imageSize);
      const croppedBlob = await cropBase64ToPngBlob(message.screenshotDataUrl, imageRect);
      const settings = await getSettings();

      const serverResponse = await describeSelection({
        image: croppedBlob,
        pageUrl: message.pageUrl,
        viewport,
        mode: message.mode,
        serverUrl: settings.serverUrl
      });

      const fallbackPrompt = buildStructuredPrompt({
        pageUrl: message.pageUrl,
        viewport,
        mode: message.mode,
        uiSummary: serverResponse.ui_summary,
        detectedElements: serverResponse.detected_elements,
        suspectedIssues: serverResponse.suspected_issues
      });

      const response = {
        ...serverResponse,
        prompt_short: serverResponse.prompt_short?.trim() ? serverResponse.prompt_short : fallbackPrompt,
        prompt_verbose: serverResponse.prompt_verbose?.trim() ? serverResponse.prompt_verbose : fallbackPrompt
      };

      const result: PersistedResult = {
        created_at: new Date().toISOString(),
        page_url: message.pageUrl,
        viewport,
        mode: message.mode,
        response
      };

      await chrome.runtime.sendMessage({
        type: "SAVE_RESULT",
        result
      } satisfies RuntimeMessage);

      setStatusText("Prompt generated. Open the extension popup to copy.");
      setTimeout(() => onClose(), 300);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to analyze selection.";
      setErrorText(text);
      setStatusText("Analysis failed.");
      await chrome.runtime.sendMessage({
        type: "CAPTURE_FAILED",
        error: text
      } satisfies RuntimeMessage);
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <div
      className="snapprompt-overlay"
      onMouseDown={beginSelection}
      onMouseMove={updateSelection}
      onMouseUp={finishSelection}
      role="presentation"
    >
      <img className="snapprompt-overlay__image" src={message.screenshotDataUrl} alt="Captured page screenshot" />
      {activeRect && (
        <div
          className="snapprompt-overlay__selection"
          style={{
            left: `${activeRect.x}px`,
            top: `${activeRect.y}px`,
            width: `${activeRect.width}px`,
            height: `${activeRect.height}px`
          }}
        />
      )}

      <div className="snapprompt-overlay__hud" onMouseDown={(event) => event.stopPropagation()}>
        <div className="snapprompt-overlay__title">BugSnap</div>
        <div className="snapprompt-overlay__mode">{MODE_LABELS[message.mode]}</div>
        <div className="snapprompt-overlay__status">{statusText}</div>
        {errorText ? <div className="snapprompt-overlay__error">{errorText}</div> : null}
        <div className="snapprompt-overlay__actions">
          <button type="button" className="snapprompt-button snapprompt-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="snapprompt-button snapprompt-button--primary"
            disabled={!selectionRect || isAnalyzing}
            onClick={() => void analyzeSelection()}
          >
            {isAnalyzing ? "Analyzing..." : "Analyze Selection"}
          </button>
        </div>
      </div>
    </div>
  );
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type !== "OPEN_OVERLAY") {
    return false;
  }

  openOverlay(message);
  sendResponse({ ok: true });
  return false;
});
