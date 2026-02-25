/**
 * BugSnap In-Page Capture Overlay
 *
 * Injected into the active tab to allow in-page region selection.
 * Communicates with service worker via chrome.runtime messaging.
 */

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OVERLAY_ID = "bugsnap-capture-overlay";
const MIN_SELECTION_PX = 3; // Only reject accidental clicks, not small selections
const OVERLAY_TIMEOUT_MS = 90_000; // Auto-close after 90s if no response
const LOG_PREFIX = "[BugSnap:Overlay]";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function clearSafetyTimer(): void {
  const timerId = (window as unknown as Record<string, unknown>).__bugsnap_safety_timer as ReturnType<typeof setTimeout> | null;
  if (timerId) {
    clearTimeout(timerId);
    (window as unknown as Record<string, unknown>).__bugsnap_safety_timer = null;
  }
}

function removeOverlay(): void {
  clearSafetyTimer();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    existing.remove();
    console.log(LOG_PREFIX, "Overlay removed from DOM");
  }
  document.removeEventListener("keydown", handleKeyDown, true);
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    console.log(LOG_PREFIX, "ESC pressed, cancelling");
    removeOverlay();
    chrome.runtime.sendMessage({ type: "OVERLAY_CANCEL" });
  }
}

function injectOverlay(): void {
  // Always remove stale overlay first
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    console.log(LOG_PREFIX, "Removing stale overlay before re-injection");
    existing.remove();
  }

  console.log(LOG_PREFIX, "Injecting overlay");

  // --- Root container ---
  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    cursor: "crosshair",
    userSelect: "none",
    fontFamily: "'Segoe UI', Tahoma, sans-serif",
  } as CSSStyleDeclaration);

  // --- Dimming layers (4 boxes around selection) ---
  const dimStyle: Partial<CSSStyleDeclaration> = {
    position: "absolute",
    background: "rgba(0, 0, 0, 0.45)",
    transition: "none",
    pointerEvents: "none",
  };

  const dimTop = document.createElement("div");
  const dimBottom = document.createElement("div");
  const dimLeft = document.createElement("div");
  const dimRight = document.createElement("div");

  [dimTop, dimBottom, dimLeft, dimRight].forEach((el) => {
    Object.assign(el.style, dimStyle);
  });

  Object.assign(dimTop.style, { top: "0", left: "0", width: "100%", height: "100%" });
  Object.assign(dimBottom.style, { top: "100%", left: "0", width: "100%", height: "0" });
  Object.assign(dimLeft.style, { top: "0", left: "0", width: "0", height: "0" });
  Object.assign(dimRight.style, { top: "0", right: "0", width: "0", height: "0" });

  root.appendChild(dimTop);
  root.appendChild(dimBottom);
  root.appendChild(dimLeft);
  root.appendChild(dimRight);

  // --- Selection border ---
  const selectionBox = document.createElement("div");
  Object.assign(selectionBox.style, {
    position: "absolute",
    border: "2px solid #00d9a3",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.3), 0 0 12px rgba(0, 217, 163, 0.3)",
    pointerEvents: "none",
    display: "none",
  } as CSSStyleDeclaration);
  root.appendChild(selectionBox);

  // --- Size indicator ---
  const sizeLabel = document.createElement("div");
  Object.assign(sizeLabel.style, {
    position: "absolute",
    background: "rgba(0, 0, 0, 0.75)",
    color: "#00d9a3",
    fontSize: "11px",
    fontWeight: "600",
    padding: "2px 6px",
    borderRadius: "3px",
    pointerEvents: "none",
    display: "none",
    whiteSpace: "nowrap",
  } as CSSStyleDeclaration);
  root.appendChild(sizeLabel);

  // --- Instruction banner ---
  const banner = document.createElement("div");
  banner.setAttribute("data-role", "banner");
  Object.assign(banner.style, {
    position: "absolute",
    top: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0, 0, 0, 0.82)",
    color: "#f0f4ff",
    fontSize: "13px",
    fontWeight: "600",
    padding: "10px 20px",
    borderRadius: "8px",
    pointerEvents: "none",
    zIndex: "1",
    textAlign: "center",
    lineHeight: "1.4",
    boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
    backdropFilter: "blur(4px)",
  } as CSSStyleDeclaration);
  banner.innerHTML = `
    <span style="color:#00d9a3">BugSnap</span> &mdash; Drag to select the area to analyze<br>
    <span style="font-size:11px;color:#9eb4df;font-weight:400">Press <kbd style="background:rgba(255,255,255,0.12);padding:1px 5px;border-radius:3px;font-size:11px">ESC</kbd> to cancel</span>
  `;
  root.appendChild(banner);

  // --- Center status banner (analyzing / error) ---
  const statusBanner = document.createElement("div");
  statusBanner.setAttribute("data-role", "status");
  Object.assign(statusBanner.style, {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: "rgba(0, 0, 0, 0.88)",
    color: "#00d9a3",
    fontSize: "15px",
    fontWeight: "700",
    padding: "16px 32px",
    borderRadius: "12px",
    pointerEvents: "none",
    zIndex: "2",
    textAlign: "center",
    display: "none",
    maxWidth: "80vw",
    lineHeight: "1.5",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    backdropFilter: "blur(8px)",
  } as CSSStyleDeclaration);
  root.appendChild(statusBanner);

  // --- State ---
  let dragStart: Point | null = null;
  let isDragging = false;

  function showStatus(text: string, color?: string): void {
    statusBanner.textContent = text;
    statusBanner.style.color = color ?? "#00d9a3";
    statusBanner.style.display = "block";
  }

  function startSafetyTimeout(): void {
    // Clear any stale timer from a previous capture/injection
    clearSafetyTimer();
    const timerId = setTimeout(() => {
      console.warn(LOG_PREFIX, "Safety timeout reached — auto-closing overlay");
      removeOverlay();
    }, OVERLAY_TIMEOUT_MS);
    (window as unknown as Record<string, unknown>).__bugsnap_safety_timer = timerId;
  }

  function updateDimRegions(rect: Rect | null): void {
    if (!rect) {
      Object.assign(dimTop.style, { top: "0", left: "0", width: "100%", height: "100%" });
      Object.assign(dimBottom.style, { height: "0" });
      Object.assign(dimLeft.style, { width: "0" });
      Object.assign(dimRight.style, { width: "0" });
      return;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    Object.assign(dimTop.style, {
      top: "0", left: "0",
      width: `${vw}px`, height: `${rect.y}px`,
    });

    const bottomY = rect.y + rect.height;
    Object.assign(dimBottom.style, {
      top: `${bottomY}px`, left: "0",
      width: `${vw}px`, height: `${vh - bottomY}px`,
    });

    Object.assign(dimLeft.style, {
      top: `${rect.y}px`, left: "0",
      width: `${rect.x}px`, height: `${rect.height}px`,
    });

    const rightX = rect.x + rect.width;
    Object.assign(dimRight.style, {
      top: `${rect.y}px`, left: `${rightX}px`,
      width: `${vw - rightX}px`, height: `${rect.height}px`,
    });
  }

  function updateSelectionVisual(rect: Rect | null): void {
    if (!rect || rect.width < 2 || rect.height < 2) {
      selectionBox.style.display = "none";
      sizeLabel.style.display = "none";
      updateDimRegions(null);
      return;
    }

    selectionBox.style.display = "block";
    selectionBox.style.left = `${rect.x}px`;
    selectionBox.style.top = `${rect.y}px`;
    selectionBox.style.width = `${rect.width}px`;
    selectionBox.style.height = `${rect.height}px`;

    sizeLabel.style.display = "block";
    sizeLabel.textContent = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    sizeLabel.style.left = `${rect.x}px`;
    sizeLabel.style.top = `${rect.y + rect.height + 4}px`;

    updateDimRegions(rect);
  }

  // --- Mouse handlers ---
  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    banner.style.display = "none";
    console.log(LOG_PREFIX, "Drag started at", dragStart);
  }

  function onMouseMove(e: MouseEvent): void {
    if (!isDragging || !dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    const current: Point = {
      x: clamp(e.clientX, 0, window.innerWidth),
      y: clamp(e.clientY, 0, window.innerHeight),
    };
    const rect = normalizeRect(dragStart, current);
    updateSelectionVisual(rect);
  }

  function onMouseUp(e: MouseEvent): void {
    if (!isDragging || !dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = false;

    const end: Point = {
      x: clamp(e.clientX, 0, window.innerWidth),
      y: clamp(e.clientY, 0, window.innerHeight),
    };
    const rect = normalizeRect(dragStart, end);
    console.log(LOG_PREFIX, "Drag ended", { start: dragStart, end, rect });
    dragStart = null;

    if (rect.width < MIN_SELECTION_PX || rect.height < MIN_SELECTION_PX) {
      // Treat as a click (no-op), let user try again — don't show an error
      console.log(LOG_PREFIX, "Click detected (no drag), ignoring:", rect.width, "x", rect.height);
      updateSelectionVisual(null);
      banner.style.display = "block";
      return;
    }

    updateSelectionVisual(rect);
    showStatus("Analyzing selection...");
    root.style.cursor = "wait";
    startSafetyTimeout();

    console.log(LOG_PREFIX, "Sending OVERLAY_SELECTION to service worker", rect);

    chrome.runtime.sendMessage(
      {
        type: "OVERLAY_SELECTION",
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(LOG_PREFIX, "Failed to send OVERLAY_SELECTION:", chrome.runtime.lastError.message);
          showStatus("Failed to reach service worker. Press ESC and try again.", "#ffb3b3");
          clearSafetyTimer();
          // Auto-close after showing error
          setTimeout(removeOverlay, 3000);
        } else {
          console.log(LOG_PREFIX, "OVERLAY_SELECTION acknowledged:", response);
        }
      }
    );
  }

  root.addEventListener("mousedown", onMouseDown, true);
  root.addEventListener("mousemove", onMouseMove, true);
  root.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keydown", handleKeyDown, true);

  document.body.appendChild(root);
  console.log(LOG_PREFIX, "Overlay injected and ready");
}

// --- Message listener for service worker commands ---
// Guard against duplicate listeners from re-injection
if (!(window as unknown as Record<string, unknown>).__bugsnap_overlay_listener) {
  (window as unknown as Record<string, unknown>).__bugsnap_overlay_listener = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "OVERLAY_DONE") {
      console.log(LOG_PREFIX, "Received OVERLAY_DONE — closing overlay");
      removeOverlay();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "OVERLAY_ERROR") {
      console.log(LOG_PREFIX, "Received OVERLAY_ERROR:", message.message);
      const overlay = document.getElementById(OVERLAY_ID);
      if (overlay) {
        const status = overlay.querySelector('[data-role="status"]') as HTMLElement | null;
        if (status) {
          status.textContent = message.message || "Analysis failed.";
          status.style.color = "#ffb3b3";
          status.style.display = "block";
        }
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "INJECT_OVERLAY") {
      console.log(LOG_PREFIX, "Received INJECT_OVERLAY");
      injectOverlay();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
}

// Auto-inject when script loads
injectOverlay();
