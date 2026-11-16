#!/usr/bin/env python3
"""
serve.py - static file server + /api/explain proxy to Claude.

  python serve.py        ->  http://localhost:5173

Why a proxy? The API key must never reach the browser. The page POSTs
{paperId, title, section, text, level} here; we build the prompt, call the
Anthropic Messages API with streaming on, and relay the text deltas back to
the browser as Server-Sent Events so the explanation types out live.

Every finished explanation is cached in cache/{paperId}_{slug}_{level}.json,
so re-running the same paper costs nothing.
"""
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import fetch_paper

PORT = 5173
MODEL = "claude-sonnet-5-5"  # change model here
MAX_TEXT = 12000
ROOT = Path(__file__).parent
CACHE = ROOT / "cache"

LEVELS = {
    "beginner": "CS freshman",
    "student": "CS student who knows basic ML",
    "researcher": "ML researcher; be precise and technical",
}

# Edit the prompt here.
PROMPT = (
    "You are explaining the '{section}' section of the ML paper '{title}' to a {level}. "
    "In under 70 words: what this section says, why it matters, and any key number or result. "
    "Use plain English and one simple analogy if it helps. Define any jargon you use. "
    "Then output one line starting with 'KEY:' containing the single most important exact "
    "phrase or number from the section text (copied exactly as written)."
)
SELECTION_PROMPT = (
    "You are explaining a passage from the ML paper '{title}' (section '{section}') to a {level}. "
    "In under 70 words, explain what this passage or equation means in plain English. "
    "Define any jargon or symbols. Then output one line starting with 'KEY:' containing the "
    "most important exact phrase from the passage (copied exactly as written)."
)


def load_env():
    """Settings from a .env file next to this script; real environment variables win."""
    env = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() and not k.strip().startswith("#"):
                env[k.strip()] = v.strip().strip("'\"")
    env.update({k: v for k, v in os.environ.items() if k in ("ANTHROPIC_API_KEY", "AI_BACKEND", "OLLAMA_MODEL")})
    return env


ENV = load_env()
API_KEY = ENV.get("ANTHROPIC_API_KEY") or None
# AI_BACKEND: "auto" (Claude if there's a key, else local Ollama), "claude" or "ollama"
AI_BACKEND = ENV.get("AI_BACKEND", "auto").lower()
OLLAMA = "http://127.0.0.1:11434"
OLLAMA_MODEL = ENV.get("OLLAMA_MODEL", "qwen3:8b")  # free, runs on your Mac, works offline


def ollama_ready():
    """Is Ollama running? If it's installed but stopped, start it (takes a few seconds)."""
    def up():
        try:
            urllib.request.urlopen(OLLAMA + "/api/tags", timeout=1).read()
            return True
        except (urllib.error.URLError, OSError):
            return False
    if up():
        return True
    if not shutil.which("ollama"):
        return False
    subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(20):
        time.sleep(0.5)
        if up():
            return True
    return False


def pick_backend():
    if AI_BACKEND == "claude" or (AI_BACKEND == "auto" and API_KEY):
        return "claude" if API_KEY else None
    return "ollama" if ollama_ready() else None


class AIError(Exception):
    pass


def stream_claude(prompt):
    """Yield text pieces from the Anthropic Messages API (streaming SSE)."""
    body = {
        "model": MODEL,
        "max_tokens": 2000,
        "stream": True,
        "output_config": {"effort": "low"},  # 70-word answers don't need deep thinking
        "fallbacks": "default",  # retry on another model if a safety classifier declines
        "messages": [{"role": "user", "content": prompt}],
    }
    api = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "server-side-fallback-2026-07-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(api, timeout=120) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:])
                if ev.get("type") == "content_block_delta" and ev["delta"].get("type") == "text_delta":
                    yield ev["delta"]["text"]
                elif ev.get("type") == "message_delta" and ev["delta"].get("stop_reason") == "refusal":
                    raise AIError("The model declined this section.")
                elif ev.get("type") == "error":
                    raise AIError(ev["error"].get("message", "API error"))
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:300]
        if "credit balance" in msg:
            msg = "Your Claude credit balance is $0. Add credits, or set AI_BACKEND=ollama in .env for the free local AI."
        raise AIError(f"Claude API {e.code}: {msg}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise AIError(f"Network error: {e}")


def stream_ollama(prompt):
    """Yield text pieces from the local Ollama model (streaming NDJSON). No internet needed."""
    body = {
        "model": OLLAMA_MODEL,
        "stream": True,
        "think": False,  # skip the model's hidden reasoning: faster, and we only want the answer
        "options": {"temperature": 0.3},
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(OLLAMA + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    in_think = False  # some models still emit <think>...</think>; hide it
    try:
        with urllib.request.urlopen(req, timeout=300) as r:  # first call loads the model: slower
            for raw in r:
                ev = json.loads(raw)
                if ev.get("error"):
                    raise AIError("Local AI: " + ev["error"])
                piece = ev.get("message", {}).get("content", "")
                if "<think>" in piece:
                    in_think, piece = True, piece.split("<think>")[0]
                if in_think and "</think>" in piece:
                    in_think, piece = False, piece.split("</think>", 1)[1]
                elif in_think:
                    continue
                if piece:
                    yield piece
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:200]
        if "not found" in msg:
            msg = f"model '{OLLAMA_MODEL}' isn't downloaded. Run: ollama pull {OLLAMA_MODEL}"
        raise AIError("Local AI: " + msg)
    except (urllib.error.URLError, TimeoutError) as e:
        raise AIError(f"Local AI isn't responding ({e}). Is Ollama running?")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "section"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always see fresh edits during dev
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/status":
            backend = pick_backend()
            return self.json({"ai": bool(backend), "backend": backend,
                              "model": MODEL if backend == "claude" else OLLAMA_MODEL})
        # keep secrets, cache and scripts off the static server (checked on the
        # resolved path so %2e / .. tricks can't reach them)
        rel = Path(self.translate_path(self.path)).resolve().relative_to(ROOT.resolve()).parts
        if rel and (rel[0] in (".env", "cache", ".claude", ".git") or rel[-1].endswith(".py")):
            return self.send_error(404)
        super().do_GET()

    def json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def fetch_paper(self):
        """POST /api/fetch {url}: download any arXiv paper (same as fetch_paper.py)."""
        try:
            arg = str(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))["url"])[:300]
            pid = fetch_paper.parse_id(arg).replace("/", "_")
        except (ValueError, KeyError, TypeError, SystemExit):
            return self.json({"error": "That doesn't look like an arXiv link or ID."}, 400)
        if (ROOT / "papers" / f"{pid}.html").exists():
            return self.json({"id": pid})  # already downloaded: works offline
        try:
            ok = fetch_paper.fetch(arg)
        except SystemExit as e:
            return self.json({"error": str(e)}, 400)
        except OSError as e:
            return self.json({"error": f"Couldn't reach arXiv ({e}). Are you online?"}, 502)
        if not ok:
            return self.json({"error": "This paper has no HTML version on arXiv, so it can't be opened here."}, 404)
        return self.json({"id": pid})

    def sse(self, event, data):
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def do_POST(self):
        if self.path == "/api/fetch":
            return self.fetch_paper()
        if self.path != "/api/explain":
            return self.send_error(404)
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            paper = slug(str(req["paperId"]))
            title = str(req["title"])[:300]
            section = str(req["section"])[:200]
            text = str(req["text"])[:MAX_TEXT]
            level = req.get("level") if req.get("level") in LEVELS else "student"
            is_sel = bool(req.get("selection"))
        except (ValueError, KeyError, TypeError):
            return self.json({"error": "bad request"}, 400)
        # selections get a hash in the cache name, since many share a section
        tag = "sel-" + hashlib.sha1(text.encode()).hexdigest()[:10] if is_sel else slug(section)
        cache_file = CACHE / f"{paper}_{tag}_{level}.json"
        backend = None if cache_file.exists() else pick_backend()
        if not backend and not cache_file.exists():
            return self.json({"error": "no_api_key"}, 503)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        if cache_file.exists():
            self.sse("delta", {"text": json.loads(cache_file.read_text())["text"]})
            return self.sse("done", {"cached": True})

        prompt = (SELECTION_PROMPT if is_sel else PROMPT).format(
            section=section, title=title, level=LEVELS[level])
        prompt += f"\n\n<section_text>\n{text}\n</section_text>"
        full = []
        try:
            for piece in (stream_claude if backend == "claude" else stream_ollama)(prompt):
                full.append(piece)
                self.sse("delta", {"text": piece})
        except AIError as e:
            print(e)
            return self.sse("error", {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            return  # browser went away; don't cache a partial answer

        if full:
            CACHE.mkdir(exist_ok=True)
            cache_file.write_text(json.dumps({"section": section, "level": level, "text": "".join(full)}))
        self.sse("done", {"cached": False})

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    b = pick_backend()
    ai = {"claude": f"Claude ({MODEL})", "ollama": f"local {OLLAMA_MODEL} via Ollama (free, offline)"}.get(
        b, "OFF: set ANTHROPIC_API_KEY or install Ollama")
    print(f"Paper Crawler on http://localhost:{PORT}  AI: {ai}")
    Server(("127.0.0.1", PORT), Handler).serve_forever()
