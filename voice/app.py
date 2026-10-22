"""Chatterbox Nano voice service for the Kira Orb.

POST /v1/audio/speech   {"input": "...", "voice": "main"}  ->  audio/wav   (OpenAI-style)
GET  /v1/voices         -> {"voices": ["forge", "main", ...]}
GET  /health            -> {"ready": bool, ...}

A voice is a reference clip in /voices named after the agent id: main.wav, forge.wav, ledger.wav.
Each clip must be longer than 5 seconds; about 10 seconds of clean, single-speaker speech works best.
"""
import asyncio, io, os, re, threading, time, wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

VOICES_DIR = Path(os.getenv("VOICES_DIR", "/voices"))
VARIANT = os.getenv("TTS_VARIANT", "nano").lower()          # nano (default) or turbo
THREADS = int(os.getenv("TORCH_THREADS", "0") or 0)
MAX_CHARS = int(os.getenv("MAX_CHARS", "600"))
VOICE_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
AUDIO_EXT = (".wav", ".mp3", ".flac", ".ogg", ".m4a")

app = FastAPI(title="Kira Orb voice")
state = {"model": None, "error": None, "loaded_at": None, "load_seconds": None}
conds_cache: dict[str, tuple[float, object]] = {}           # voice -> (file mtime, conditionals)
gen_lock = threading.Lock()                                  # one model, one CPU job at a time


def load_model():
    try:
        import torch
        if THREADS > 0:
            torch.set_num_threads(THREADS)
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        t0 = time.time()
        print(f"[voice] loading Chatterbox {VARIANT} on cpu (first start downloads the weights)…", flush=True)
        state["model"] = ChatterboxTurboTTS.from_pretrained(device="cpu", nano=(VARIANT == "nano"))
        state["load_seconds"] = round(time.time() - t0, 1)
        state["loaded_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(f"[voice] ready in {state['load_seconds']}s, {torch.get_num_threads()} threads", flush=True)
    except Exception as e:  # keep serving /health so the orb can show what went wrong
        state["error"] = f"{type(e).__name__}: {e}"
        print(f"[voice] failed to load model: {state['error']}", flush=True)


@app.on_event("startup")
def startup():
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=load_model, daemon=True).start()


def voice_file(name: str) -> Path | None:
    if not VOICE_RE.match(name):
        return None
    for ext in AUDIO_EXT:
        p = VOICES_DIR / f"{name}{ext}"
        if p.is_file():
            return p
    return None


def list_voices() -> list[str]:
    if not VOICES_DIR.is_dir():
        return []
    return sorted({p.stem for p in VOICES_DIR.iterdir() if p.suffix.lower() in AUDIO_EXT and VOICE_RE.match(p.stem)})


def synthesize(text: str, voice: str) -> bytes:
    model = state["model"]
    path = voice_file(voice)
    if path is None:
        raise HTTPException(404, f"No voice clip named '{voice}' in the voices folder.")
    with gen_lock:
        mtime = path.stat().st_mtime
        cached = conds_cache.get(voice)
        if not cached or cached[0] != mtime:            # analyse each clip once, re-analyse if the file changes
            try:
                model.prepare_conditionals(str(path))
            except AssertionError as e:
                raise HTTPException(422, f"Voice clip '{path.name}' is too short: {e}") from e
            conds_cache[voice] = (mtime, model.conds)
        model.conds = conds_cache[voice][1]
        import torch
        with torch.inference_mode():
            wav = model.generate(text)
        sr = model.sr
    pcm = np.clip(wav.squeeze(0).cpu().numpy(), -1.0, 1.0)
    pcm = (pcm * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return buf.getvalue()


class SpeechRequest(BaseModel):
    input: str = Field(..., min_length=1)
    voice: str
    model: str | None = None
    response_format: str | None = "wav"
    speed: float | None = None       # accepted for compatibility; Chatterbox has no speed control


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if state["model"] is None:
        raise HTTPException(503, state["error"] or "The voice model is still loading.")
    if (req.response_format or "wav") != "wav":
        raise HTTPException(400, "Only wav output is supported.")
    text = req.input.strip()[:MAX_CHARS]
    t0 = time.time()
    audio = await asyncio.to_thread(synthesize, text, req.voice)
    secs = len(audio) / (2 * state["model"].sr)
    return Response(audio, media_type="audio/wav", headers={
        "X-Gen-Seconds": f"{time.time() - t0:.2f}", "X-Audio-Seconds": f"{secs:.2f}", "Cache-Control": "no-store"})


@app.get("/v1/voices")
def voices():
    return {"voices": list_voices()}


@app.get("/health")
def health():
    return {"ready": state["model"] is not None, "variant": VARIANT, "error": state["error"],
            "load_seconds": state["load_seconds"], "voices": list_voices()}
