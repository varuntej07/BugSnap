# BugSnap

BugSnap is a Chrome extension backed by a local FastAPI server that turns selected UI screenshots into structured prompts for coding workflows.

Instead of describing bugs from memory, you select the exact UI region, run analysis, and copy a prompt that includes:

- what is visible
- likely UI issues
- implementation guidance
- short and verbose prompt variants

## Why BugSnap

- Fast: capture and analyze from your current tab in seconds
- Local-first: analysis runs against your local server by default
- Practical output: prompts are ready to paste into coding agents
- Built for iteration: tune prompt mode, re-capture, and compare results quickly

## Features

- Chrome extension popup for capture and prompt controls
- Capture Studio tab for visual region selection
- Structured server response with UI summary, elements, issues, and prompts
- Multiple prompt modes:
  - `ui_bug_fix`
  - `ui_polish`
  - `implement_like_this`
- In-memory request rate limiting and payload guards on the server
- Florence-2 backend with safe fallback when model dependencies are unavailable

## Architecture

### Extension

- Service worker captures the active tab screenshot
- Screenshot payload is saved in extension storage
- Capture Studio opens as an extension page (`capture/index.html`)
- Selected crop is sent to the local server (`POST /describe`)
- Generated result is persisted and shown in both Capture Studio and popup

### Server

- FastAPI app receives image input and request metadata
- Florence-2 backend generates visual description
- Prompt builder creates short + verbose prompts from the description
- JSON response is returned to the extension

## Repository Layout

```text
BugSnap/
  extension/
    background/service_worker.ts
    capture/Capture.tsx
    capture/capture.css
    capture/index.html
    popup/Popup.tsx
    popup/index.html
    shared/httpClient.ts
    shared/imageCrop.ts
    shared/promptTemplates.ts
    shared/types.ts
    public/manifest.json
    vite.config.ts
  server/
    app.py
    vlm.py
    prompt_builder.py
    requirements.txt
  README.md
  LICENSE
```

## Prerequisites

- Windows/macOS/Linux
- Python 3.10+
- Node.js 18+ and npm
- Google Chrome (latest stable)
- Internet access for first-time model downloads

## Quick Start

### 1. Clone the repository

```powershell
git clone https://github.com/varuntej07/BugSnap.git
cd BugSnap
```

### 2. Start the local server

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Health check:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/health
```

Expected response shape:

```json
{
  "status": "ok",
  "backend": "microsoft/Florence-2-base"
}
```

If model loading fails, backend may be `fallback-heuristic`.

### 3. Build the Chrome extension

Open a new terminal from repository root:

```powershell
cd extension
npm install
npm run build
```

### 4. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `extension/dist`

### 5. Capture and analyze

1. Open any web page
2. Open BugSnap popup
3. Verify server URL (default: `http://127.0.0.1:8000`)
4. Click `Start Capture` (shortcut: `Ctrl+Shift+Y`, macOS: `Command+Shift+Y`)
5. In Capture Studio, drag a selection
6. Click `Analyze Selection`
7. Copy the generated prompt

## API Overview

### `GET /health`

Returns service status and active backend name.

### `POST /describe`

Input fields:

- `image` (multipart file) or `image_base64`
- `mode`: `ui_bug_fix | ui_polish | implement_like_this`
- `page_url` (optional)
- `viewport_width`
- `viewport_height`

Response fields:

- `ui_summary`
- `detected_elements`
- `suspected_issues`
- `prompt_short`
- `prompt_verbose`

Example response:

```json
{
  "ui_summary": "Top navigation with search and action buttons.",
  "detected_elements": [
    { "type": "nav", "notes": "Detected via textual cues related to navigation, navbar." },
    { "type": "button", "notes": "Detected via textual cues related to button, cta." }
  ],
  "suspected_issues": [
    "Potential spacing inconsistency between adjacent elements."
  ],
  "prompt_short": "...",
  "prompt_verbose": "..."
}
```

## Configuration

BugSnap supports environment-based configuration.

### Preferred environment variables

- `BUGSNAP_VLM_BACKEND` (default: `florence2`)
- `BUGSNAP_VLM_MODEL` (default: `microsoft/Florence-2-base`)
- `BUGSNAP_MAX_NEW_TOKENS` (default: `200`)
- `BUGSNAP_RATE_LIMIT_PER_MINUTE` (default: `12`)
- `BUGSNAP_MAX_REQUEST_MB` (default: `6`)
- `BUGSNAP_MAX_IMAGE_MB` (default: `5`)
- `BUGSNAP_MAX_IMAGE_PIXELS` (default: `40000000`)
- `BUGSNAP_LOG_LEVEL` (default: `INFO`)

Legacy `SNAPPROMPT_*` variable names are also recognized for backward compatibility.

Example:

```powershell
$env:BUGSNAP_VLM_MODEL = "microsoft/Florence-2-base"
$env:BUGSNAP_MAX_NEW_TOKENS = "256"
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

## Developer Workflow

### Server

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

### Extension

```powershell
cd extension
npm run build
```

For continuous build during development:

```powershell
npm run dev
```

Type-check:

```powershell
npm run typecheck
```

## Troubleshooting

### Backend loads as `fallback-heuristic`

Run:

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -c "import sys, torch, transformers, timm, einops; print(sys.executable); print(transformers.__version__)"
```

Then restart server.

### Missing `timm`

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

### Florence-2 error with `additional_special_tokens`

This project is pinned to Transformers 4.x for Florence-2 compatibility. Reinstall dependencies from `server/requirements.txt`:

```powershell
cd server
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade --force-reinstall -r requirements.txt
python -c "import transformers; print(transformers.__version__)"
```

`transformers` major version should be `4`.

### Capture does not start

1. Ensure your target tab is active before capture
2. Avoid restricted browser pages (`chrome://*`, extension pages, web store pages)
3. Rebuild extension and reload in `chrome://extensions`
4. Confirm server is reachable at `http://127.0.0.1:8000/health`

### Old behavior still appears after changes

1. Rebuild extension
2. Reload extension in `chrome://extensions`
3. Close older Capture Studio tabs
4. Start a fresh capture flow

## Privacy

- Screenshot is captured from the active tab when you trigger capture
- Only the selected crop is sent to the local server
- Server target defaults to localhost
- Results/settings are stored in extension local storage

## Performance Notes

- Florence-2 on CPU can be slow for large crops
- Smaller selections reduce inference time
- GPU-enabled PyTorch significantly improves response speed

## Contributing

1. Fork the repository
2. Create a feature branch
3. Implement and test changes
4. Build extension and verify server behavior
5. Open a pull request with testing notes and screenshots where relevant

## License

MIT
