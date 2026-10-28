"""Kyutai Pocket TTS voice service for the Kira Orb.

POST /v1/audio/speech   {"input": "...", "voice": "main"}  ->  audio/wav   (OpenAI-style)
GET  /v1/voices         -> {"voices": [...], "custom": [...], "defaults": [...], "builtin": [...]}
POST /v1/voice-prepare  {"voice": "main"}  -> analyses the voice now: {"ok": true, "kind": "custom", ...} or 404/422
GET  /v1/voice-sample?voice=default:forge   -> the reference clip as the model hears it (audio/wav)
GET  /health            -> {"ready": bool, ...}

A voice is a reference clip named after the agent id: main.mp3, forge.wav, ledger.wav … (.wav or .mp3; the name's
capitals don't matter). Two folders are searched, in order:
  CUSTOM_VOICES_DIR  (/custom-voices) clips chosen in the orb's Voice Manager (the orb writes them; read-only here)
  VOICES_DIR         (/voices)        the default clips kept in the Orbis repo
Voice names can also say exactly which voice to use (the Voice Manager uses these to try a voice before picking it):
  default:<agent>   the repo clip only        clip:<id>   a clip in the orb's library (CUSTOM_VOICES_DIR/library)
  builtin:<name>    one of Pocket TTS's built-in voices (alba, marius, jane …)
Clips are converted to clean mono WAV; they need at least 5 seconds of speech and anything past 15 seconds is trimmed
off. Each voice is analysed once and kept in memory (again if its file changes). BUILTIN_VOICES can give agents
without a clip one of the built-in voices, e.g. "scout=alba,dana=jane".
"""
import asyncio, hashlib, io, os, re, subprocess, tempfile, threading, time, wave
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

VOICES_DIR = Path(os.getenv("VOICES_DIR", "/voices"))
CUSTOM_DIR = Path(os.getenv("CUSTOM_VOICES_DIR", "/custom-voices"))
THREADS = int(os.getenv("TORCH_THREADS", "2") or 2)
MAX_CHARS = int(os.getenv("MAX_CHARS", "600"))
# Pocket TTS attends to the whole reference clip while speaking, so longer clips make every sentence slower.
# 5–15 seconds of speech is used: shorter clips are rejected, longer ones are trimmed to 15 s.
MIN_CLIP_SECONDS = float(os.getenv("MIN_CLIP_SECONDS", "5"))
MAX_CLIP_SECONDS = float(os.getenv("MAX_CLIP_SECONDS", "15"))
MAX_CLIP_BYTES = int(os.getenv("MAX_CLIP_BYTES", str(10 * 1024 * 1024)))
BUILTIN = dict(p.split("=", 1) for p in os.getenv("BUILTIN_VOICES", "").replace(" ", "").split(",") if "=" in p)
VOICE_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
CLIP_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")
# Pocket TTS's built-in English voices (the Voice Manager offers these). Override with BUILTIN_CATALOG="alba,jane".
BUILTIN_CATALOG = [v for v in os.getenv("BUILTIN_CATALOG", "alba,anna,azelma,bill_boerst,caro_davy,charles,cosette,"
                   "eponine,eve,fantine,george,jane,javert,jean,marius,mary,michael,paul,peter_yearsley,stuart_bell,vera"
                   ).replace(" ", "").split(",") if VOICE_RE.match(v)]
CACHE_MAX = int(os.getenv("VOICE_CACHE_MAX", "12"))
AUDIO_EXT = (".wav", ".mp3")
TMP = Path(tempfile.gettempdir()) / "voice-prompts"

app = FastAPI(title="Kira Orb voice (Pocket TTS)")
state = {"model": None, "error": None, "load_seconds": None}
voice_cache: "OrderedDict[str, tuple[float, object]]" = OrderedDict()   # source -> (file mtime, voice state)
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


def _clip_in(folder: Path, name: str) -> Path | None:
    if not VOICE_RE.match(name) or not folder.is_dir():
        return None
    for ext in AUDIO_EXT:
        p = folder / f"{name}{ext}"
        if p.is_file():
            return p
    # the same name with different capitals (Ledger.mp3 for agent "ledger"): Windows doesn't keep them apart
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix.lower() in AUDIO_EXT and p.stem.lower() == name.lower():
            return p
    return None


def clip_for(name: str) -> Path | None:
    """The clip an agent speaks with: the one picked in the Voice Manager, else the repo's default clip."""
    return _clip_in(CUSTOM_DIR, name) or _clip_in(VOICES_DIR, name)


def _names_in(folder: Path) -> set[str]:
    if not folder.is_dir():
        return set()
    return {p.stem.lower() for p in folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXT and VOICE_RE.match(p.stem)}


def list_voices() -> list[str]:
    return sorted(_names_in(CUSTOM_DIR) | _names_in(VOICES_DIR) | set(BUILTIN))


def resolve(name: str) -> tuple[str, object]:
    """('custom'|'default', Path) or ('builtin', voice name) for any voice name the orb can send."""
    if name.startswith("builtin:"):
        b = name[8:]
        if b in BUILTIN_CATALOG or b in BUILTIN.values():
            return "builtin", b
        raise HTTPException(404, f"No built-in voice named '{b}'.")
    if name.startswith("clip:"):
        cid = name[5:]
        p = CUSTOM_DIR / "library" / f"{cid}.wav"
        if CLIP_ID_RE.match(cid) and p.is_file():
            return "custom", p
        raise HTTPException(404, "That voice clip isn't in the library (the voice service can't see the orb's voice folder?).")
    if name.startswith("default:"):
        p = _clip_in(VOICES_DIR, name[8:])
        if p:
            return "default", p
        raise HTTPException(404, f"No default clip named '{name[8:]}' in the voices folder.")
    p = _clip_in(CUSTOM_DIR, name)
    if p:
        return "custom", p
    p = _clip_in(VOICES_DIR, name)
    if p:
        return "default", p
    if name in BUILTIN:
        return "builtin", BUILTIN[name]
    raise HTTPException(404, f"No voice clip named '{name}' in the voices folder.")


def prepared_wav(src: Path) -> Path:
    """Validate and convert an accepted clip to 24 kHz mono 16-bit WAV, trimmed to MAX_CLIP_SECONDS."""
    if src.suffix.lower() not in AUDIO_EXT:
        raise HTTPException(415, "Voice clips must be .wav or .mp3.")
    if src.stat().st_size > MAX_CLIP_BYTES:
        raise HTTPException(413, f"Voice clip exceeds the {MAX_CLIP_BYTES // (1024 * 1024)} MB limit.")
    out = TMP / (hashlib.sha1(str(src).encode()).hexdigest()[:16] + ".wav")   # a repo clip and a custom one can share a name
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-t", str(MAX_CLIP_SECONDS + 3),
           "-af", "silenceremove=start_periods=1:start_threshold=-45dB", "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not out.exists():
        raise HTTPException(422, f"Couldn't read voice clip '{src.name}': {r.stderr.strip()[:200]}")
    with wave.open(str(out)) as w:
        secs = w.getnframes() / w.getframerate()
    if secs < MIN_CLIP_SECONDS:
        raise HTTPException(422, f"Voice clip '{src.name}' has {secs:.1f}s of speech; it needs at least {MIN_CLIP_SECONDS:.0f} seconds.")
    if secs > MAX_CLIP_SECONDS:   # longer clips are trimmed, not rejected (a longer reference only makes speech slower)
        trimmed = out.with_suffix(".trim.wav")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(out), "-t", str(MAX_CLIP_SECONDS), str(trimmed)], capture_output=True, text=True, timeout=60)
        if r.returncode != 0 or not trimmed.exists():
            raise HTTPException(422, f"Couldn't trim voice clip '{src.name}': {r.stderr.strip()[:200]}")
        trimmed.replace(out)
    return out


def voice_state(name: str):
    """Call with gen_lock held."""
    model = state["model"]
    kind, src = resolve(name)
    if kind == "builtin":
        key, mtime = "builtin:" + src, 0
    else:
        key, mtime = str(src), src.stat().st_mtime
    cached = voice_cache.get(key)
    if not cached or cached[0] != mtime:          # analyse each clip once, again if the file changes
        prompt = src if kind == "builtin" else str(prepared_wav(src))
        voice_cache[key] = (mtime, model.get_state_for_audio_prompt(prompt))
        while len(voice_cache) > CACHE_MAX:       # voices tried in the Voice Manager don't pile up in memory
            voice_cache.popitem(last=False)
    voice_cache.move_to_end(key)
    return voice_cache[key][1]


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
    return {"voices": list_voices(), "custom": sorted(_names_in(CUSTOM_DIR)), "defaults": sorted(_names_in(VOICES_DIR)),
            "builtin": BUILTIN_CATALOG, "custom_dir": CUSTOM_DIR.is_dir()}


class VoiceRequest(BaseModel):
    voice: str = Field(..., min_length=1, max_length=80)


@app.post("/v1/voice-prepare")
async def voice_prepare(req: VoiceRequest):
    """Check and analyse a voice now (the orb calls this when a voice is uploaded or picked), so a bad clip is
    reported straight away and the agent's first reply isn't slowed down by the analysis."""
    if state["model"] is None:
        raise HTTPException(503, state["error"] or "The voice model is still loading.")
    kind, src = resolve(req.voice)
    t0 = time.time()

    def run():
        with gen_lock:
            voice_state(req.voice)
            if kind == "builtin":
                return None
            with wave.open(str(prepared_wav(src))) as w:
                return round(w.getnframes() / w.getframerate(), 2)
    secs = await asyncio.to_thread(run)
    return {"ok": True, "voice": req.voice, "kind": kind, "file": None if kind == "builtin" else src.name,
            "clip_seconds": secs, "seconds": round(time.time() - t0, 2)}


@app.get("/v1/voice-sample")
async def voice_sample(voice: str = Query(..., min_length=1, max_length=80)):
    """The reference clip as the model hears it (cleaned and trimmed), to play in the Voice Manager."""
    kind, src = resolve(voice)
    if kind == "builtin":
        raise HTTPException(404, "Built-in voices have no clip to play; use Try instead.")
    def run():
        with gen_lock:                            # prepared_wav writes a shared temp file
            return prepared_wav(src).read_bytes()
    audio = await asyncio.to_thread(run)
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.get("/health")
def health():
    return {"ready": state["model"] is not None, "engine": "pocket-tts", "error": state["error"],
            "load_seconds": state["load_seconds"], "voices": list_voices()}
