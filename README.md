# BugSnap

BugSnap is a Chrome extension that turns selected UI screenshots into structured prompts for coding agents.

Instead of describing bugs from memory, you select the exact UI region, run analysis, and copy a prompt that includes:

- what is visible
- likely UI issues
- implementation guidance
- short and verbose prompt variants

## Why BugSnap

- Fast: capture and analyze from your current tab in seconds
- Zero setup: hosted backend on Vercel, no local server required
- In-page capture: select a region directly on your page without leaving your tab
- Practical output: prompts are ready to paste into Codex, Claude Code, or any coding agent
- Built for iteration: tune prompt mode, re-capture, and compare results quickly

## Features

- Chrome extension popup for capture and prompt controls
- In-page sniper overlay for fast region selection (no extra tabs)
- Fallback Capture Studio tab when content script injection is blocked
- OpenAI GPT-4o Vision backend for high-quality UI analysis
- Structured server response with UI summary, elements, issues, and prompts
- Multiple prompt modes:
  - `ui_bug_fix` - fix layout and visual bugs
  - `ui_polish` - improve spacing, hierarchy, and visual consistency
  - `implement_like_this` - recreate the selected region as a design reference
- Production error contract with structured error codes and retryable flags
- Request rate limiting and payload guards
- Degraded mode detection with visible UI indicators

## Architecture

### Extension

- Service worker captures the active tab screenshot
- Content script injects an in-page overlay for region selection
- Selected crop is sent to the hosted backend (`POST /describe`)
- Generated result is persisted in extension storage and shown in popup
- Falls back to Capture Studio tab when content script injection fails

### Server (Vercel Serverless)

- FastAPI app deployed as a Vercel serverless function (`index.py`)
- OpenAI GPT-4o Vision generates detailed UI description
- Prompt builder creates short + verbose prompts from the description
- JSON response with error contract returned to the extension

## Repository Layout

```text
BugSnap/
  index.py                   # Vercel serverless entry point
  extension/
    background/service_worker.ts
    capture/Capture.tsx       # Fallback Capture Studio
    capture/capture.css
    capture/index.html
    content/overlay.ts        # In-page sniper overlay
    popup/Popup.tsx
    popup/popup.css
    popup/index.html
    shared/httpClient.ts
    shared/imageCrop.ts
    shared/promptTemplates.ts
    shared/types.ts
    public/manifest.json
    scripts/                  # Preflight and smoke test scripts
    vite.config.ts
  server/
    app.py
    vlm.py
    prompt_builder.py
    requirements.txt          # Local dev (Florence-2 + torch)
  requirements.txt            # Vercel deployment (lightweight)
  vercel.json
  README.md
  LICENSE
```

## Quick Start

### 1. Build the Chrome extension

```bash
cd extension
npm install
npm run build
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `extension/dist`

### 3. Capture and analyze

1. Open any web page
2. Click the BugSnap icon (or press `Ctrl+Shift+Y` / `Cmd+Shift+Y`)
3. Drag to select the area you want analyzed
4. Wait for analysis to complete
5. Open popup and copy the generated prompt

The extension connects to the hosted backend at `https://bugsnap.vercel.app` by default. No local server setup is needed.

## Deploying the Backend

The backend is deployed on Vercel as a Python serverless function.

### Environment Variables (Vercel Dashboard)

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4o Vision |
| `BUGSNAP_VLM_BACKEND` | No | Backend to use (default: `openai`) |
| `BUGSNAP_OPENAI_MODEL` | No | OpenAI model (default: `gpt-4o`) |
| `BUGSNAP_AUTH_TOKEN` | No | Bearer token for API auth |
| `BUGSNAP_ALLOWED_ORIGINS` | No | Comma-separated CORS origins |
| `BUGSNAP_RATE_LIMIT_PER_MINUTE` | No | Rate limit per IP (default: `12`) |
| `BUGSNAP_REQUEST_TIMEOUT_SECONDS` | No | Max inference time (default: `60`) |
| `BUGSNAP_MAX_REQUEST_MB` | No | Max request size (default: `6`) |
| `BUGSNAP_MAX_IMAGE_MB` | No | Max image size (default: `5`) |

### Deploy

```bash
vercel --prod
```

Or connect your GitHub repo to Vercel for automatic deployments on push.

## API Overview

### `GET /health`

Returns service status, active backend name, and degraded flag.

### `POST /describe`

Input fields:

- `image` (multipart file) or `image_base64`
- `mode`: `ui_bug_fix | ui_polish | implement_like_this`
- `page_url` (optional)
- `viewport_width`
- `viewport_height`

Response fields:

- `ok`, `request_id`, `backend_name`, `degraded`
- `ui_summary`
- `detected_elements`
- `suspected_issues`
- `prompt_short`
- `prompt_verbose`

Error response fields:

- `ok: false`, `error_code`, `user_message`, `dev_message`, `request_id`, `retryable`

## Local Development

### Server (optional, for local testing)

```bash
cd server
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
BUGSNAP_VLM_BACKEND=openai OPENAI_API_KEY=sk-... uvicorn app:app --port 8000 --reload
```

Then set the server URL in the extension popup's advanced settings to `http://127.0.0.1:8000`.

### Extension

```bash
cd extension
npm run dev       # Watch mode
npm run typecheck # Type check
npm run preflight # Manifest + dist validation
```

## Privacy

- Screenshots are captured only when you trigger capture
- Only the selected crop is sent to the backend for analysis
- Images are not stored on the server
- Results and settings are stored in extension local storage only

## Author

Built by [Varun Tej](https://varuntej.dev)

## License

MIT
