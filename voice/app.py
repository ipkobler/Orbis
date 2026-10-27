"""Kyutai Pocket TTS voice service for the Kira Orb.

POST /v1/audio/speech   {"input": "...", "voice": "main"}  ->  audio/wav   (OpenAI-style)
GET  /v1/voices         -> {"voices": ["forge", "ledger", "main"]}
GET  /health            -> {"ready": bool, ...}

A voice is a reference clip in /voices named after the agent id: main.mp3, forge.wav, ledger.wav …
(.wav or .mp3). Clips are converted to clean mono WAV and must be 10–15 seconds long, and each
voice is analysed once and kept in memory. BUILTIN_VOICES can give agents without a clip one of Pocket
TTS's built-in voices, e.g. "scout=alba,dana=jane".
"""
import asyncio, io, os, re, subprocess, tempfile, threading, time, wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

VOICES_DIR = Path(os.getenv("VOICES_DIR", "/voices"))
THREADS = int(os.getenv("TORCH_THREADS", "2") or 2)
MAX_CHARS = int(os.getenv("MAX_CHARS", "600"))
# Pocket TTS attends to the whole reference clip while speaking, so longer clips make every sentence slower.
# Ten to fifteen seconds is the accepted reference range.
MIN_CLIP_SECONDS = float(os.getenv("MIN_CLIP_SECONDS", "10"))
MAX_CLIP_SECONDS = float(os.getenv("MAX_CLIP_SECONDS", "15"))
MAX_CLIP_BYTES = int(os.getenv("MAX_CLIP_BYTES", str(10 * 1024 * 1024)))
BUILTIN = dict(p.split("=", 1) for p in os.getenv("BUILTIN_VOICES", "").replace(" ", "").split(",") if "=" in p)
VOICE_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
AUDIO_EXT = (".wav", ".mp3")
TMP = Path(tempfile.gettempdir()) / "voice-prompts"

app = FastAPI(title="Kira Orb voice (Pocket TTS)")
state = {"model": None, "error": None, "load_seconds": None}
voice_cache: dict[str, tuple[float, object]] = {}           # voice -> (source mtime, voice state)
gen_lock = threading.Lock()


def load_model():
    try:
        import torch
        torch.set_num_threads(THREADS)
        from pocket_tts import TTSModel
        t0 = time.time()
        print("[voice] loading Pocket TTS (first start downloads the weights)…", flush=True)
        state["model"] = TTSModel.load_model()
        state["load_seconds"] = round(time.time() - t0, 1)
        print(f"[voice] ready in {state['load_seconds']}s, {torch.get_num_threads()} threads", flush=True)
        warm_voices()
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        if any(k in msg for k in ("401", "403", "gated", "GatedRepo", "Unauthorized", "access")):
            msg = ("Can't download Pocket TTS: accept the terms at https://huggingface.co/kyutai/pocket-tts "
                   "and put a Read token in voice.env as HF_TOKEN. (" + msg[:200] + ")")
        state["error"] = msg
        print(f"[voice] failed to load model: {msg}", flush=True)


def warm_voices():
    # Analysing a clip is the slow step, so do every agent's clip now instead of on its first reply.
    for name in list_voices():
        t0 = time.time()
        try:
            with gen_lock:
                voice_state(name)
            print(f"[voice] prepared voice '{name}' in {time.time() - t0:.1f}s", flush=True)
        except Exception as e:
            print(f"[voice] couldn't prepare voice '{name}': {getattr(e, 'detail', e)}", flush=True)


@app.on_event("startup")
def startup():
    TMP.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=load_model, daemon=True).start()


def clip_for(name: str) -> Path | None:
    if not VOICE_RE.match(name) or not VOICES_DIR.is_dir():
        return None
    for ext in AUDIO_EXT:
        p = VOICES_DIR / f"{name}{ext}"
        if p.is_file():
            return p
    return None


def list_voices() -> list[str]:
    clips = {p.stem for p in VOICES_DIR.iterdir() if p.suffix.lower() in AUDIO_EXT and VOICE_RE.match(p.stem)} if VOICES_DIR.is_dir() else set()
    return sorted(clips | set(BUILTIN))


def prepared_wav(src: Path) -> Path:
    """Validate and convert an accepted clip to 24 kHz mono 16-bit WAV."""
    if src.suffix.lower() not in AUDIO_EXT:
        raise HTTPException(415, "Voice clips must be .wav or .mp3.")
    if src.stat().st_size > MAX_CLIP_BYTES:
        raise HTTPException(413, f"Voice clip exceeds the {MAX_CLIP_BYTES // (1024 * 1024)} MB limit.")
    out = TMP / f"{src.stem}.wav"
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src),
           "-af", "silenceremove=start_periods=1:start_threshold=-45dB", "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not out.exists():
        raise HTTPException(422, f"Couldn't read voice clip '{src.name}': {r.stderr.strip()[:200]}")
    with wave.open(str(out)) as w:
        secs = w.getnframes() / w.getframerate()
    if secs < MIN_CLIP_SECONDS or secs > MAX_CLIP_SECONDS:
        raise HTTPException(422, f"Voice clip '{src.name}' must be {MIN_CLIP_SECONDS:.0f}–{MAX_CLIP_SECONDS:.0f} seconds; found {secs:.1f}s.")
    return out


def voice_state(name: str):
    model = state["model"]
    clip = clip_for(name)
    if clip is not None:
        key, mtime = name, clip.stat().st_mtime
        cached = voice_cache.get(key)
        if not cached or cached[0] != mtime:          # analyse each clip once, again if the file changes
            voice_cache[key] = (mtime, model.get_state_for_audio_prompt(str(prepared_wav(clip))))
        return voice_cache[key][1]
    if name in BUILTIN:
        key = "builtin:" + BUILTIN[name]
        if key not in voice_cache:
            voice_cache[key] = (0, model.get_state_for_audio_prompt(BUILTIN[name]))
        return voice_cache[key][1]
    raise HTTPException(404, f"No voice clip named '{name}' in the voices folder.")


def synthesize(text: str, voice: str) -> bytes:
    model = state["model"]
    with gen_lock:
        vs = voice_state(voice)
        # No torch.inference_mode() here: Pocket TTS runs part of generation on a worker thread, which wouldn't
        # inherit that mode, and mixing modes makes it crash. It manages gradients itself.
        audio = model.generate_audio(vs, text)
        sr = int(model.sample_rate)
    pcm = np.clip(audio.detach().cpu().numpy().reshape(-1), -1.0, 1.0)
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
    speed: float | None = None       # accepted for compatibility; not supported


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if state["model"] is None:
        raise HTTPException(503, state["error"] or "The voice model is still loading.")
    if (req.response_format or "wav") != "wav":
        raise HTTPException(400, "Only wav output is supported.")
    t0 = time.time()
    text = req.input.strip()[:MAX_CHARS]
    audio = await asyncio.to_thread(synthesize, text, req.voice)
    secs = (len(audio) - 44) / (2 * int(state["model"].sample_rate))
    print(f"[voice] {req.voice}: {len(text)} chars -> {secs:.1f}s of speech in {time.time() - t0:.2f}s", flush=True)
    return Response(audio, media_type="audio/wav", headers={
        "X-Gen-Seconds": f"{time.time() - t0:.2f}", "X-Audio-Seconds": f"{secs:.2f}", "Cache-Control": "no-store"})


@app.get("/v1/voices")
def voices():
    return {"voices": list_voices()}


@app.get("/health")
def health():
    return {"ready": state["model"] is not None, "engine": "pocket-tts", "error": state["error"],
            "load_seconds": state["load_seconds"], "voices": list_voices()}
