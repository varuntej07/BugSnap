# SnapPrompt (Chrome Extension + Local VLM Server)

SnapPrompt captures the current tab, lets you draw a rectangle over the UI, sends only the cropped region to a local FastAPI VLM server, and returns structured prompts you can paste into Codex/Claude Code.

## Stack
- Extension: Manifest V3, TypeScript, React, Vite
- Server: FastAPI, transformers, PyTorch
- Default model backend: Florence-2 (`microsoft/Florence-2-base`)

## Project Layout
```
extension/
  background/service_worker.ts
  content/overlay.tsx
  popup/Popup.tsx
  shared/types.ts
  shared/promptTemplates.ts
  shared/imageCrop.ts
  shared/httpClient.ts
  public/manifest.json
server/
  app.py
  vlm.py
  prompt_builder.py
  requirements.txt
```

## 1) Run Local Inference Server
From repo root:

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Optional environment variables:

```powershell
$env:SNAPPROMPT_VLM_BACKEND = "florence2"
$env:SNAPPROMPT_VLM_MODEL = "microsoft/Florence-2-base"
$env:SNAPPROMPT_RATE_LIMIT_PER_MINUTE = "12"
$env:SNAPPROMPT_MAX_REQUEST_MB = "6"
```

Health check:

```powershell
curl http://127.0.0.1:8000/health
```

## 2) Build and Load the Extension
From repo root:

```powershell
cd extension
npm install
npm run build
```

Load unpacked in Chrome:
1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `extension/dist`

## 3) Use SnapPrompt
1. Open extension popup and confirm server URL (`http://127.0.0.1:8000` by default).
2. Start capture either:
   - Click `Start Capture` in popup, or
   - Press `Ctrl+Shift+Y` (default command hotkey).
3. Drag a rectangle over the fullscreen screenshot overlay.
4. Click `Analyze Selection`.
5. Open popup, choose short/verbose prompt, click `Copy`, and paste into Codex/Claude Code.

## Privacy Defaults
- Images are not stored by the extension.
- Only the cropped selection is sent.
- Default server target is localhost (`127.0.0.1`), local-only flow.

## API Contract (`POST /describe`)
Input:
- `image` (multipart file) or `image_base64` (form field)
- `mode`: `ui_bug_fix | ui_polish | implement_like_this`
- `page_url` (optional)
- `viewport_width`, `viewport_height`

Output:
```json
{
  "ui_summary": "...",
  "detected_elements": [
    { "type": "button", "notes": "..." }
  ],
  "suspected_issues": ["..."],
  "prompt_short": "...",
  "prompt_verbose": "..."
}
```

## Notes
- Florence-2 on CPU is slower; GPU is recommended for faster iterations.
- Server includes request size guards and in-memory per-IP rate limiting.
