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
const MIN_SELECTION_PX = 12;

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

function removeOverlay(): void {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    existing.remove();
  }
  document.removeEventListener("keydown", handleKeyDown, true);
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    removeOverlay();
    chrome.runtime.sendMessage({ type: "OVERLAY_CANCEL" });
  }
}

function injectOverlay(): void {
  // Prevent double injection
  if (document.getElementById(OVERLAY_ID)) {
    return;
  }

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

  // Initial state: full dim
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

  // --- Analyzing state banner ---
  const analyzingBanner = document.createElement("div");
  Object.assign(analyzingBanner.style, {
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
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    backdropFilter: "blur(8px)",
  } as CSSStyleDeclaration);
  analyzingBanner.textContent = "Analyzing selection...";
  root.appendChild(analyzingBanner);

  // --- State ---
  let dragStart: Point | null = null;
  let isDragging = false;
  let finalRect: Rect | null = null;

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

    // Top: full width, from top to selection top
    Object.assign(dimTop.style, {
      top: "0", left: "0",
      width: `${vw}px`, height: `${rect.y}px`,
    });

    // Bottom: full width, from selection bottom to viewport bottom
    const bottomY = rect.y + rect.height;
    Object.assign(dimBottom.style, {
      top: `${bottomY}px`, left: "0",
      width: `${vw}px`, height: `${vh - bottomY}px`,
    });

    // Left: from selection top to selection bottom, left edge to selection left
    Object.assign(dimLeft.style, {
      top: `${rect.y}px`, left: "0",
      width: `${rect.x}px`, height: `${rect.height}px`,
    });

    // Right: from selection top to selection bottom, selection right to viewport right
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
    sizeLabel.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
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
    finalRect = null;
    dragStart = { x: e.clientX, y: e.clientY };
    banner.style.display = "none";
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
    dragStart = null;

    if (rect.width < MIN_SELECTION_PX || rect.height < MIN_SELECTION_PX) {
      updateSelectionVisual(null);
      banner.style.display = "block";
      banner.innerHTML = `
        <span style="color:#ffb3b3">Selection too small</span> &mdash; Drag a larger area<br>
        <span style="font-size:11px;color:#9eb4df;font-weight:400">Press <kbd style="background:rgba(255,255,255,0.12);padding:1px 5px;border-radius:3px;font-size:11px">ESC</kbd> to cancel</span>
      `;
      return;
    }

    finalRect = rect;
    updateSelectionVisual(rect);

    // Show "analyzing" state
    analyzingBanner.style.display = "block";
    root.style.cursor = "wait";

    // Send selection to service worker
    chrome.runtime.sendMessage({
      type: "OVERLAY_SELECTION",
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  root.addEventListener("mousedown", onMouseDown, true);
  root.addEventListener("mousemove", onMouseMove, true);
  root.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keydown", handleKeyDown, true);

  document.body.appendChild(root);
}

// --- Message listener for service worker commands ---
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "INJECT_OVERLAY") {
    injectOverlay();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OVERLAY_ANALYZING") {
    const banner = document.querySelector(`#${OVERLAY_ID} div:last-child`) as HTMLElement | null;
    // Already showing analyzing state from mouseup
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "OVERLAY_DONE") {
    removeOverlay();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Auto-inject when script loads
injectOverlay();
