"""
Vercel serverless entry point.

Imports the FastAPI app from server/ so there's no code duplication.
Vercel detects the ASGI app automatically.
"""

import os
import sys

# Make server/ modules importable (app.py, vlm.py, prompt_builder.py)
_server_dir = os.path.join(os.path.dirname(__file__), "..", "server")
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from app import app  # noqa: E402 — path must be set before import
