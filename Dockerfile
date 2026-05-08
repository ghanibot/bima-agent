# ── Base ──────────────────────────────────────────────────────────
FROM node:20-slim

# Install ffmpeg for voice-note transcription
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ── Working directory ─────────────────────────────────────────────
WORKDIR /app

# ── Install production dependencies ───────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── Copy application source ───────────────────────────────────────
COPY src/ ./src/
COPY bin/ ./bin/

# ── Data volume (WhatsApp auth, knowledge base, plugins) ──────────
VOLUME ["/data"]
ENV BIMA_DATA=/data

# ── Entrypoint ───────────────────────────────────────────────────
CMD ["node", "src/cli.js"]
