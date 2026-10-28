# Kyutai Pocket TTS voice service: voice cloning on CPU (about 100M parameters, uses 2 cores).
# The model weights are gated on Hugging Face: accept the terms at https://huggingface.co/kyutai/pocket-tts
# and put a Read token in /docker/agent-stack/voice.env as HF_TOKEN=... (see README).
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch first, so pip doesn't pull the multi-GB CUDA build
RUN pip install --no-cache-dir torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu

ARG POCKET_TTS_VERSION=
RUN pip install --no-cache-dir "pocket-tts${POCKET_TTS_VERSION:+==$POCKET_TTS_VERSION}" \
      --extra-index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir fastapi==0.115.6 "uvicorn[standard]==0.32.1" numpy

WORKDIR /app
COPY app.py .
ENV HF_HOME=/cache PYTHONUNBUFFERED=1 VOICES_DIR=/voices CUSTOM_VOICES_DIR=/custom-voices
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
