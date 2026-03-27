# Start from the official Playwright + Node image.
# This gives us Node.js and a working Chromium install with all its
# Linux dependencies already sorted — the hardest part of the setup.
FROM mcr.microsoft.com/playwright/node:20-jammy

WORKDIR /app

# Install ffmpeg and yt-dlp.
# apt-get handles ffmpeg; yt-dlp comes from its own installer since the
# apt package is often outdated and yt-dlp updates frequently.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
 && rm -rf /var/lib/apt/lists/* \
 && wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

# Copy dependency manifest first — Docker caches each layer, so if
# package.json hasn't changed, it skips the npm install on rebuilds.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app.
COPY server.js ./
COPY public/ ./public/

# The port the app listens on.
EXPOSE 3003

# Where downloaded media is written inside the container.
# This directory gets mapped to a real folder on the host via docker-compose.
ENV MEDIA_ROOT=/media

CMD ["node", "server.js"]
