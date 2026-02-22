# BugSnap

BugSnap is a Chrome extension + local AI server that helps you turn UI screenshots into high-quality coding prompts.

You open any webpage, capture a region, and BugSnap generates structured prompts for tasks like:

- fixing UI bugs
- improving visual polish
- implementing a UI section as a reference

It runs locally by default and sends only the cropped region to your local server.

## What You Get

- Chrome extension for fast capture
- Capture Studio tab to draw a selection rectangle
- Local FastAPI server for UI understanding and prompt generation
- Structured output (`ui_summary`, `detected_elements`, `suspected_issues`, short/verbose prompts)
- Built-in fallback behavior if Florence-2 cannot load

## Who This Is For

- Frontend developers
- Full-stack developers
- Freelancers doing rapid UI fixes
- Anyone who wants better prompt context before using coding agents

## Tech Stack

- Extension: Manifest V3, React, TypeScript, Vite
- Server: FastAPI, PyTorch, Transformers
- Default model backend: Florence-2 (`microsoft/Florence-2-base`)

## Project Layout

```text
BugSnap/
  extension/
    background/service_worker.ts
    capture/Capture.tsx
    capture/capture.css
    popup/Popup.tsx
    shared/
      httpClient.ts
      imageCrop.ts
      promptTemplates.ts
      types.ts
    public/manifest.json
  server/
    app.py
    vlm.py
    prompt_builder.py
    requirements.txt
  README.md
```

## How BugSnap Works

1. You click `Start Capture` in the extension popup.
2. The background service worker captures the current visible tab screenshot.
3. BugSnap opens `Capture Studio` in a new extension tab.
4. You drag to select only the region you care about.
5. BugSnap sends that cropped image to your local server (`POST /describe`).
6. The server generates structured analysis and prompts.
7. You copy the prompt and paste it into your coding assistant workflow.

## Prerequisites

Install these first:

- Google Chrome (latest stable)
- Python 3.10+ (3.11/3.12 recommended)
- Node.js 18+ and npm
- Internet connection on first model download (Hugging Face model files)

## Quick Start (Windows PowerShell)

### 1. Clone and open the repo

```powershell
git clone https://github.com/varuntej07/BugSnap.git
cd BugSnap
```

### 2. Set up and run the local server

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Server should start at:

- `http://127.0.0.1:8000`

Health check (PowerShell, no curl):

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/health
```

### 3. Build the extension

Open a new terminal at repo root:

```powershell
cd extension
npm install
npm run build
```

### 4. Load extension in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode` (top-right)
3. Click `Load unpacked`
4. Select `extension/dist`

### 5. Run your first capture

1. Open any webpage you want to inspect.
2. Click BugSnap extension icon.
3. Confirm server URL is `http://127.0.0.1:8000` (default).
4. Click `Start Capture` (or press `Ctrl+Shift+Y` on Windows/Linux, `Command+Shift+Y` on macOS).
5. In Capture Studio, drag to select an area.
6. Click `Analyze Selection`.
7. Copy generated prompt and use it in your coding assistant.

## Prompt Modes

BugSnap supports three task modes:

- `ui_bug_fix`: fix broken alignment, overflow, spacing, clipping, etc.
- `ui_polish`: improve visual rhythm and hierarchy while preserving behavior.
- `implement_like_this`: recreate selected UI region as a design target.

You can switch mode in the popup before starting capture.

## Output Format

`POST /describe` returns:

```json
{
  "ui_summary": "string",
  "detected_elements": [
    { "type": "button", "notes": "string" }
  ],
  "suspected_issues": ["string"],
  "prompt_short": "string",
  "prompt_verbose": "string"
}
```

Element types include:

- `button`
- `input`
- `modal`
- `nav`
- `card`
- `table`
- `text`

## Server API

### GET `/health`

Returns status and active backend.

PowerShell example:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/health
```

Typical response:

```json
{
  "status": "ok",
  "backend": "microsoft/Florence-2-base"
}
```

If Florence-2 is unavailable, backend may be:

```json
{
  "status": "ok",
  "backend": "fallback-heuristic"
}
```

### POST `/describe`

Accepts multipart file upload (`image`) or base64 image (`image_base64`) plus:

- `mode`
- `page_url` (optional)
- `viewport_width`
- `viewport_height`

## Configuration

BugSnap server supports these environment variables:

- `BUGSNAP_VLM_BACKEND` (default: `florence2`)
- `BUGSNAP_VLM_MODEL` (default: `microsoft/Florence-2-base`)
- `BUGSNAP_MAX_NEW_TOKENS` (default: `200`)
- `BUGSNAP_RATE_LIMIT_PER_MINUTE` (default: `12`)
- `BUGSNAP_MAX_REQUEST_MB` (default: `6`)
- `BUGSNAP_MAX_IMAGE_MB` (default: `5`)
- `BUGSNAP_MAX_IMAGE_PIXELS` (default: `40000000`)
- `BUGSNAP_LOG_LEVEL` (default: `INFO`)

Legacy `SNAPPROMPT_*` names are still accepted for backward compatibility.

Example:

```powershell
$env:BUGSNAP_VLM_MODEL = "microsoft/Florence-2-base"
$env:BUGSNAP_MAX_NEW_TOKENS = "220"
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

## Development Workflow

### Extension

```powershell
cd extension
npm install
npm run build
```

For continuous rebuild during development:

```powershell
npm run dev
```

### Server

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

## Troubleshooting

### 1) Server starts, but backend is `fallback-heuristic`

Check:

- You installed dependencies in the same Python interpreter used to run Uvicorn.
- You can import `torch`, `transformers`, `einops`, and `timm`.

Quick check:

```powershell
python -c "import sys, torch, transformers, timm, einops; print(sys.executable); print(transformers.__version__)"
```

### 2) `No module named 'timm'`

Install missing dependency in your active venv:

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

### 3) Error mentions `TokenizersBackend` and `additional_special_tokens`

Your environment likely has `transformers` 5.x.
This project pins Transformers to `<5.0` for Florence-2 compatibility.

Fix:

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade --force-reinstall -r requirements.txt
python -c "import transformers; print(transformers.__version__)"
```

Expected major version: `4`.

### 4) Extension popup works, but capture does not start

Try these:

1. Ensure target tab is active.
2. Avoid restricted pages (`chrome://*`, web store, extension pages).
3. Rebuild extension and click `Reload` in `chrome://extensions`.
4. Confirm host permissions include your local server URL (`127.0.0.1:8000`).

### 5) You still see old capture behavior after changes

This usually means stale extension assets are loaded.

1. Rebuild:
   `cd extension`
   `npm run build`
2. Reload extension in `chrome://extensions`.
3. Close old Capture Studio tabs and start a new capture.

### 6) Hugging Face download or model load fails

- First run needs network access to download model files.
- Corporate VPN/firewall/proxy can block model downloads.
- Retry after network access is stable.

## Privacy and Data Handling

- BugSnap captures a screenshot in your browser.
- Only the selected cropped region is sent to your local server.
- By default, server URL is localhost (`127.0.0.1`), so processing stays on your machine.
- Extension stores settings and latest result in local extension storage.

## Performance Notes

- Florence-2 on CPU can be slow for large selections.
- Smaller selected regions are faster.
- GPU acceleration (CUDA-enabled PyTorch) improves inference speed.

## Common "First Day" Checklist

If you want a reliable first run:

1. Start server and keep terminal open.
2. Verify `GET /health` returns `status: ok`.
3. Build extension and load `extension/dist`.
4. Start capture from a normal webpage.
5. Make a medium-size selection and analyze.
6. Confirm prompt appears in Capture Studio.

## Contributing

1. Fork the repo.
2. Create a feature branch.
3. Make changes.
4. Rebuild extension and test server.
5. Open a pull request with:
   - what changed
   - why it changed
   - how to test

## License

Add your preferred license file (MIT, Apache-2.0, etc.) if you plan to publish or distribute.
