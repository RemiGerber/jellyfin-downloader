# Jellyfin HLS Downloader

A self-hosted web app for downloading HLS and other video streams, with support for full season batch downloads, automatic show following, and real-time progress tracking.

---

## Features

- **Manual downloads** — paste one or more stream URLs with show/episode metadata
- **Bulk season downloads** — auto-detect episode counts and download entire seasons
- **Follow Show mode** — check for new episodes on a schedule and download them automatically
- **Stream detection** — headless Chromium intercepts `.m3u8`/`.mpd`/`.mp4` streams from any page URL
- **Multi-strategy fallback** — tries yt-dlp → wget → ffmpeg copy → ffmpeg re-encode
- **Real-time progress** — speed, ETA, and codec method via WebSocket
- **Jellyfin-compatible output** — files saved as `Show Name S01E01.mp4` in a standard folder structure

---

## Quick Start with Docker

### 1. Pull and run (pre-built image)

```bash
docker run -d \
  --name jellyfin-downloader \
  -p 3003:3003 \
  -v /mnt/nas:/media \
  -v jellyfin-downloader-data:/app/data \
  -e MEDIA_ROOT=/media \
  --restart unless-stopped \
  ubbrelf/jellyfin-downloader:latest
```

Then open **http://localhost:3003** in your browser.

---

### 2. Docker Compose (recommended)

Copy the sample below into a `docker-compose.yml` file, adjust the volume path, and run:

```bash
docker compose up -d
```

#### Sample `docker-compose.yml`

```yaml
services:
  jellyfin-downloader:
    image: ubbrelf/jellyfin-downloader:latest
    container_name: jellyfin-downloader
    ports:
      # Change the left (host) port if 3003 is already in use.
      - "3003:3003"
    volumes:
      # Left side  = path on your host where media should be saved.
      # Right side = must stay /media (matches MEDIA_ROOT below).
      # Examples:
      #   - /mnt/nas:/media
      #   - /home/youruser/media:/media
      #   - D:\Media:/media   (Windows with WSL2 / Docker Desktop)
      - /mnt/nas:/media
      # Persists followed-shows.json across container restarts.
      - jellyfin-downloader-data:/app/data
    environment:
      # Must match the right side of the volume mount above.
      - MEDIA_ROOT=/media
      # Uncomment to change the internal port (also update the port mapping).
      # - PORT=3003
    restart: unless-stopped

volumes:
  jellyfin-downloader-data:
```

---

### 3. Build from source

```bash
git clone https://github.com/your-username/jellyfin-downloader.git
cd jellyfin-downloader

# Build and start
docker compose up -d --build
```

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `MEDIA_ROOT` | `/media` | Path **inside the container** where files are written. Must match the right side of your volume mount. |
| `PORT` | `3003` | Port the Node.js server listens on inside the container. |

All other settings (User-Agent, Referer, Cookie, retry count, quality preference, check intervals) are configured through the web UI at runtime.

---

## Output Structure

Downloaded files are organized to match Jellyfin's naming conventions:

```
$MEDIA_ROOT/
├── shows/
│   └── Breaking Bad/
│       ├── Season 01/
│       │   ├── Breaking Bad S01E01.mp4
│       │   └── Breaking Bad S01E02.mp4
│       └── Season 02/
│           └── Breaking Bad S02E01.mp4
└── movies/
    └── Inception (2010)/
        └── Inception (2010).mp4
```

---

## Volumes

| Mount | Purpose |
|---|---|
| `/media` | Media output directory. Map this to your Jellyfin library root (or a subfolder). |
| `/app/data` | App data (followed shows list). Use a named volume or bind mount to persist across restarts. |

---

## Ports

| Port | Protocol | Description |
|---|---|---|
| `3003` | TCP | Web UI and API |

---

## Usage Overview

### Manual Download

1. Open the web UI and select **Manual** mode.
2. Paste one or more video stream URLs (or a page URL to auto-detect).
3. Enter the show name, season, and episode number (or mark as a movie).
4. Click **Download**.

### Bulk Season Download

1. Switch to **Bulk** mode.
2. Enter the show's page URL and click **Auto-detect Info** to fetch season/episode counts.
3. Review the detected seasons, adjust ranges if needed.
4. Click **Start Bulk Download**.

### Follow Show (automatic)

1. Switch to **Follow** mode.
2. Enter the show page URL and a check interval (1–24 hours).
3. The app will periodically check for new episodes and download them automatically.
4. Optionally enable **Download existing episodes** to backfill on first add.

---

## Updating

```bash
# Pull the latest image and recreate the container
docker compose pull
docker compose up -d
```

---

## Uninstall

```bash
# Stop and remove the container
docker compose down

# Also remove the named data volume (deletes followed shows list)
docker compose down -v
```

---

## Troubleshooting

**Downloads fail immediately**
Run `docker compose logs -f` and check for `ffmpeg not found` or `yt-dlp not found`. These are bundled in the image — if missing, the image may not have built correctly. Rebuild with `docker compose up -d --build`.

**Stream not detected**
Some sites block headless browsers. Try setting a realistic **User-Agent** and **Referer** in the UI settings before running detection.

**Port conflict**
Change the host port in `docker-compose.yml`:
```yaml
ports:
  - "3004:3003"   # use 3004 on the host instead
```

**Files not appearing in Jellyfin**
Verify that the left side of your `/media` volume mount points to the same directory your Jellyfin library scans. Trigger a library scan in Jellyfin after downloads complete.

---

## Tech Stack

- **Backend:** Node.js + Express + WebSocket (`ws`)
- **Browser automation:** Playwright (headless Chromium)
- **Video processing:** ffmpeg, yt-dlp, wget
- **Frontend:** React 18 + Tailwind CSS (loaded via CDN, no build step)
- **Base image:** `node:20-bookworm-slim`
