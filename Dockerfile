# Standard Node 20 on Debian Bookworm (slim = smaller image, no GUI fluff).
FROM node:20-bookworm-slim

WORKDIR /app

# Install ffmpeg, wget, and the system libraries Playwright's Chromium needs.
# We install ffmpeg and wget via apt; yt-dlp via its own binary since the
# apt package is usually outdated.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    ca-certificates \
    python3 \
 && rm -rf /var/lib/apt/lists/* \
 && wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

# Copy dependency manifest first — Docker caches this layer, so if
# package.json hasn't changed, npm install is skipped on rebuilds.
COPY package*.json ./
RUN npm ci --omit=dev

# Install the Chromium build that matches this exact Playwright version,
# plus all its Linux system dependencies. Must run after npm ci so
# Playwright's version is known.
RUN npx playwright install --with-deps chromium

# Copy the rest of the app.
COPY server.js ./
COPY public/ ./public/

# The port the app listens on.
EXPOSE 3003

# Where downloaded media is written inside the container.
# Mapped to a real host folder via docker-compose volumes.
ENV MEDIA_ROOT=/media

CMD ["node", "server.js"]
