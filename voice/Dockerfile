# Chatterbox Nano voice service: Resemble AI's official code behind a small OpenAI-style speech API.
# CPU-only build. The model weights (~0.5 GB) download from Hugging Face on first start into /cache.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends git libsndfile1 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# CPU builds of the exact torch version Chatterbox pins, so pip doesn't pull the multi-GB CUDA build
RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu

# Resemble AI's official package (includes Nano). Pin a commit later with CHATTERBOX_REF if you like.
ARG CHATTERBOX_REF=master
RUN pip install --no-cache-dir "chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@${CHATTERBOX_REF}" \
 && pip install --no-cache-dir fastapi==0.115.6 "uvicorn[standard]==0.32.1"

WORKDIR /app
COPY app.py .
ENV HF_HOME=/cache PYTHONUNBUFFERED=1 VOICES_DIR=/voices
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
