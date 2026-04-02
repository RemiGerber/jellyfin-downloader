const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const https = require('https');
const { chromium } = require('playwright');
const vpn = require('./vpn-manager');

const app = express();
const PORT = process.env.PORT || 3003;
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/mnt/nas';
const TEMP_DOWNLOAD_DIR = '/tmp/hls_downloads';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const activeDownloads = new Map();
const downloadProgress = new Map(); // id -> last progress data, for restoring on reconnect
let bulkJobActive = false;
let manualJobActive = false;
let currentBulkState = null;
const deps = { ytDlp: false, ffmpeg: false };

// Spawns a command inside the VPN network namespace when VPN is active,
// otherwise spawns it normally. All download tools use this so their
// traffic routes through WireGuard when a VPN profile is connected.
function spawnWithVpn(cmd, args, options = {}) {
  const prefix = vpn.getExecPrefix();
  const [fullCmd, ...fullArgs] = [...prefix, cmd, ...args];
  return spawn(fullCmd, fullArgs, options);
}

function broadcast(data) {
  // Track state so new WS clients can receive current job status
  if (data.type === 'progress') {
    if (data.status === 'completed' || data.status === 'failed') {
      downloadProgress.delete(data.id);
    } else {
      downloadProgress.set(data.id, data);
    }
  } else if (data.type === 'bulk-status') {
    currentBulkState = data;
  } else if (data.type === 'bulk-complete') {
    bulkJobActive = false;
    currentBulkState = null;
  } else if (data.type === 'complete') {
    manualJobActive = false;
  }

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Give vpn-manager access to broadcast so it can push status updates to clients
vpn.setBroadcast(broadcast);

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseProgress(line) {
  const pairs = {};
  line.split('\n').forEach(l => {
    const [key, value] = l.split('=');
    if (key && value) {
      pairs[key.trim()] = value.trim();
    }
  });
  return pairs;
}

function parseOutSeconds(progress) {
  if (progress.out_time_ms) {
    return parseInt(progress.out_time_ms) / 1000000;
  } else if (progress.out_time) {
    const parts = progress.out_time.split(':');
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

function createFilename(options, index) {
  if (options.mediaType === 'tv') {
    const { showName, seasonNumber, startEpisode } = options;
    const episodeNum = startEpisode + index;
    return `${showName} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}.mp4`;
  } else {
    const { movieName, movieYear } = options;
    return `${movieName} (${movieYear}).mp4`;
  }
}

function createDirectoryPath(options) {
  if (options.mediaType === 'tv') {
    const { showName, seasonNumber } = options;
    return `${MEDIA_ROOT}/shows/${showName}/Season ${String(seasonNumber).padStart(2, '0')}`;
  } else {
    const { movieName, movieYear } = options;
    return `${MEDIA_ROOT}/movies/${movieName} (${movieYear})`;
  }
}

async function commandExists(cmd) {
  try {
    const result = await new Promise((resolve) => {
      const process = spawn('which', [cmd]);
      process.on('close', (code) => resolve(code === 0));
    });
    return result;
  } catch {
    return false;
  }
}

// Builds the common ffmpeg input args shared by all ffmpeg-based strategies
function buildFfmpegBaseArgs(url, settings) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'info'];

  if (settings.userAgent) {
    args.push('-user_agent', settings.userAgent);
  }

  if (settings.referer || settings.cookie) {
    let headers = '';
    if (settings.referer) headers += `Referer: ${settings.referer}\r\n`;
    if (settings.cookie) headers += `Cookie: ${settings.cookie}\r\n`;
    args.push('-headers', headers);
  }

  args.push(
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
  );

  return args;
}

// Pick the best stream from a list based on quality preference
function pickStream(streams, quality) {
  if (!streams.length) return null;

  const withRes = streams.filter(s => s.resolution);
  const pool = withRes.length > 0 ? withRes : streams;

  if (!quality || quality === 'best') {
    return [...pool].sort((a, b) => {
      const ha = parseInt((a.resolution || '').split('x')[1]) || 0;
      const hb = parseInt((b.resolution || '').split('x')[1]) || 0;
      return hb - ha;
    })[0];
  }

  // Exact quality label match first (e.g. '1080p')
  const exact = pool.find(s => s.quality === quality);
  if (exact) return exact;

  // Closest resolution
  const targetHeight = parseInt(quality);
  if (!isNaN(targetHeight) && withRes.length > 0) {
    return [...withRes].sort((a, b) => {
      const ha = parseInt(a.resolution.split('x')[1]) || 0;
      const hb = parseInt(b.resolution.split('x')[1]) || 0;
      return Math.abs(ha - targetHeight) - Math.abs(hb - targetHeight);
    })[0];
  }

  return streams[0];
}

// Recursively extracts season/episode info from various API response shapes
// Handles TMDB format, nested structures, and alternate key names
function extractShowInfoFromData(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 6) return null;

  // Pattern: array of season objects [{season_number, episode_count}]
  if (Array.isArray(data) && data.length > 0) {
    const seasonItems = data.filter(d =>
      d && typeof d === 'object' &&
      (d.season_number !== undefined || d.seasonNumber !== undefined) &&
      (d.episode_count !== undefined || d.episodeCount !== undefined || Array.isArray(d.episodes))
    );
    if (seasonItems.length > 0) {
      const seasons = seasonItems
        .map(s => ({
          season: s.season_number ?? s.seasonNumber,
          episodeCount: s.episode_count ?? s.episodeCount ?? (Array.isArray(s.episodes) ? s.episodes.length : 0),
        }))
        .filter(s => s.season > 0 && s.episodeCount > 0)
        .sort((a, b) => a.season - b.season)
        .map(s => ({ season: s.season, startEpisode: 1, endEpisode: s.episodeCount }));
      if (seasons.length > 0) return { seasons, showName: null };
    }
  }

  if (!Array.isArray(data)) {
    // Pattern: { seasons: [...], name: "..." } — direct TMDB-style
    if (Array.isArray(data.seasons) && data.seasons.length > 0) {
      const info = extractShowInfoFromData(data.seasons, depth + 1);
      if (info) return { ...info, showName: info.showName || data.name || data.title || data.show_name || null };
    }

    // Try common nested keys
    for (const key of ['result', 'data', 'show', 'tv', 'series', 'media', 'content', 'info', 'details']) {
      if (data[key] && typeof data[key] === 'object') {
        const info = extractShowInfoFromData(data[key], depth + 1);
        if (info) return { ...info, showName: info.showName || data.name || data.title || null };
      }
    }
  }

  return null;
}

async function downloadWithYtDlp(url, outputPath, options, downloadId, filename) {
  console.log('Attempting download with yt-dlp...');

  const args = [
    '-o', outputPath,
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--no-check-certificate',
    '--concurrent-fragments', '5',
    '--no-part',
  ];

  if (options.settings.userAgent) {
    args.push('--user-agent', options.settings.userAgent);
  }
  if (options.settings.referer) {
    args.push('--referer', options.settings.referer);
  }
  if (options.settings.cookie) {
    args.push('--add-header', `Cookie: ${options.settings.cookie}`);
  }

  args.push('--newline', '--progress');
  args.push(url);

  return new Promise((resolve, reject) => {
    const ytdlp = spawnWithVpn('yt-dlp', args);
    let lastProgress = 0;

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();

      const percentMatch = output.match(/(\d+\.?\d*)%/);
      if (percentMatch) {
        const progress = parseFloat(percentMatch[1]);
        if (progress > lastProgress) {
          lastProgress = progress;

          const speedMatch = output.match(/(\d+\.?\d*\w+\/s)/);
          const etaMatch = output.match(/ETA\s+(\S+)/);

          broadcast({
            type: 'progress',
            id: downloadId,
            filename,
            url,
            status: 'downloading',
            progress,
            speed: speedMatch ? speedMatch[1] : undefined,
            eta: etaMatch ? etaMatch[1] : undefined,
            method: 'yt-dlp'
          });
        }
      }
    });

    ytdlp.stderr.on('data', (data) => {
      console.log('yt-dlp stderr:', data.toString());
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`yt-dlp failed with code ${code}`));
      }
    });
  });
}

async function downloadWithEnhancedFfmpeg(url, outputPath, options, downloadId, filename) {
  console.log('Attempting download with enhanced ffmpeg...');

  const progressFile = path.join(TEMP_DOWNLOAD_DIR, `${downloadId}.progress`);
  const args = buildFfmpegBaseArgs(url, options.settings);
  args.push(
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-bsf:a', 'aac_adtstoasc',  // Fix AAC streams
    '-y',
    outputPath,
    '-progress', progressFile
  );

  return new Promise((resolve, reject) => {
    const ffmpeg = spawnWithVpn('ffmpeg', args);
    let totalDuration = 0;
    let stderr = '';

    // Fetch duration in parallel — updates totalDuration when it resolves
    const ffprobe = spawnWithVpn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      url
    ]);
    let durationOutput = '';
    ffprobe.stdout.on('data', d => { durationOutput += d.toString(); });
    ffprobe.on('close', () => {
      const duration = parseFloat(durationOutput.trim());
      if (!isNaN(duration)) totalDuration = duration;
    });
    setTimeout(() => ffprobe.kill(), 10000);

    const progressMonitor = setInterval(async () => {
      try {
        const progressData = await fs.readFile(progressFile, 'utf8');
        const progress = parseProgress(progressData);
        const outSeconds = parseOutSeconds(progress);

        let percentage = 0;
        let eta;
        if (totalDuration > 0 && outSeconds > 0) {
          percentage = (outSeconds / totalDuration) * 100;
          const speed = parseFloat(progress.speed || 1);
          const remaining = totalDuration - outSeconds;
          if (speed > 0) eta = formatTime(remaining / speed);
        }

        broadcast({
          type: 'progress',
          id: downloadId,
          filename,
          url,
          status: 'downloading',
          progress: Math.min(percentage, 100),
          speed: progress.speed ? `${progress.speed}x` : undefined,
          eta,
          method: 'ffmpeg-enhanced'
        });
      } catch {
        // Progress file not ready yet
      }
    }, 500);

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      clearInterval(progressMonitor);
      fs.unlink(progressFile).catch(() => {});

      if (code === 0) {
        resolve(true);
      } else if (stderr.includes('codec') || stderr.includes('Codec')) {
        reject(new Error('CODEC_COPY_FAILED'));
      } else {
        reject(new Error(`ffmpeg failed with code ${code}`));
      }
    });
  });
}

async function downloadWithReencoding(url, outputPath, options, downloadId, filename) {
  console.log('Attempting download with re-encoding...');

  const progressFile = path.join(TEMP_DOWNLOAD_DIR, `${downloadId}.progress`);
  const args = buildFfmpegBaseArgs(url, options.settings);
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath,
    '-progress', progressFile
  );

  return new Promise((resolve, reject) => {
    const ffmpeg = spawnWithVpn('ffmpeg', args);
    let totalDuration = 0;

    const progressMonitor = setInterval(async () => {
      try {
        const progressData = await fs.readFile(progressFile, 'utf8');
        const progress = parseProgress(progressData);
        const outSeconds = parseOutSeconds(progress);

        if (progress.total_size && !totalDuration) {
          totalDuration = outSeconds * 1.1; // Estimate
        }

        broadcast({
          type: 'progress',
          id: downloadId,
          filename,
          url,
          status: 'downloading',
          progress: Math.min(totalDuration > 0 ? (outSeconds / totalDuration) * 100 : 0, 99),
          speed: progress.speed ? `${progress.speed}x` : undefined,
          method: 'ffmpeg-reencode'
        });
      } catch {
        // Progress file not ready yet
      }
    }, 1000);

    ffmpeg.on('close', (code) => {
      clearInterval(progressMonitor);
      fs.unlink(progressFile).catch(() => {});

      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`Re-encoding failed with code ${code}`));
      }
    });
  });
}

async function downloadWithWget(url, outputPath, options, downloadId, filename) {
  console.log('Attempting direct download with wget...');

  let referer = options.settings.referer || '';
  try {
    const proxyHeaders = new URL(url).searchParams.get('headers');
    if (proxyHeaders) {
      const h = JSON.parse(decodeURIComponent(proxyHeaders));
      if (h.Referer) referer = h.Referer;
    }
  } catch {}

  const args = [
    '--no-check-certificate',
    '--progress=dot:mega',
    '-U', options.settings.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-O', outputPath,
  ];
  if (referer) args.push('--referer', referer);
  if (options.settings.cookie) args.push('--header', `Cookie: ${options.settings.cookie}`);
  args.push(url);

  return new Promise((resolve, reject) => {
    const wget = spawnWithVpn('wget', args);
    let lastProgress = 0;

    wget.stderr.on('data', data => {
      const text = data.toString();
      const match = text.match(/(\d+)%/);
      if (match) {
        const progress = parseInt(match[1]);
        if (progress > lastProgress) {
          lastProgress = progress;
          broadcast({ type: 'progress', id: downloadId, filename, url, status: 'downloading', progress, method: 'wget' });
        }
      }
    });

    wget.on('close', code => {
      if (code === 0) resolve(true);
      else reject(new Error(`wget failed with code ${code}`));
    });
  });
}

async function downloadUrl(url, options, index, totalCount) {
  const filename = createFilename(options, index);
  const dirPath = createDirectoryPath(options);
  const outputPath = path.join(dirPath, filename);
  const downloadId = `${Date.now()}_${index}`;

  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    console.error('Error creating directory:', err);
    throw err;
  }

  try {
    await fs.access(outputPath);
    broadcast({
      type: 'progress',
      id: downloadId,
      filename,
      url,
      status: 'completed',
      progress: 100,
      message: 'File already exists, skipping'
    });
    return { success: true, skipped: true };
  } catch {
    // File doesn't exist, proceed with download
  }

  console.log(`\nStarting download [${index + 1}/${totalCount}]: ${filename}`);
  console.log(`URL: ${url}`);

  if (!deps.ffmpeg) {
    throw new Error('ffmpeg is not installed');
  }

  activeDownloads.set(downloadId, { filename, url, startedAt: Date.now() });

  try {
    broadcast({
      type: 'progress',
      id: downloadId,
      filename,
      url,
      status: 'starting',
      progress: 0
    });

    const strategies = [];
    const isDirectMp4 = /\.mp4(\?|$)/.test(url) || (url.includes('/proxy?') && url.includes('.mp4'));

    if (deps.ytDlp) {
      strategies.push({
        name: 'yt-dlp',
        fn: () => downloadWithYtDlp(url, outputPath, options, downloadId, filename)
      });
    }

    if (isDirectMp4) {
      strategies.push({ name: 'wget', fn: () => downloadWithWget(url, outputPath, options, downloadId, filename) });
    }

    if (!isDirectMp4) {
      strategies.push(
        {
          name: 'ffmpeg-enhanced',
          fn: () => downloadWithEnhancedFfmpeg(url, outputPath, options, downloadId, filename)
        },
        {
          name: 'ffmpeg-reencode',
          fn: () => downloadWithReencoding(url, outputPath, options, downloadId, filename)
        }
      );
    } else {
      strategies.push({
        name: 'ffmpeg-copy',
        fn: () => downloadWithEnhancedFfmpeg(url, outputPath, options, downloadId, filename)
      });
    }

    let lastError;

    for (const strategy of strategies) {
      for (let attempt = 1; attempt <= options.settings.retries; attempt++) {
        try {
          console.log(`Trying ${strategy.name} (attempt ${attempt}/${options.settings.retries})...`);

          broadcast({
            type: 'progress',
            id: downloadId,
            filename,
            url,
            status: 'downloading',
            progress: 0,
            attempt,
            method: strategy.name
          });

          await strategy.fn();

          console.log(`✓ Successfully downloaded with ${strategy.name}: ${filename}`);
          broadcast({
            type: 'progress',
            id: downloadId,
            filename,
            url,
            status: 'completed',
            progress: 100,
            method: strategy.name
          });

          // Track bytes for VPN auto-rotation
          let fileBytes = 0;
          try { const stat = await fs.stat(outputPath); fileBytes = stat.size; } catch {}
          vpn.trackDownload({ bytes: fileBytes, failed: false }).catch(() => {});

          return { success: true, method: strategy.name };

        } catch (err) {
          console.error(`✗ ${strategy.name} attempt ${attempt} failed:`, err.message);
          lastError = err;

          if (err.message === 'CODEC_COPY_FAILED') {
            console.log('Codec copy failed, skipping to re-encoding...');
            break;
          }

          if (attempt < options.settings.retries) {
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`Waiting ${delay / 1000}s before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }

    console.error('All download strategies failed');
    broadcast({
      type: 'progress',
      id: downloadId,
      filename,
      url,
      status: 'failed',
      progress: 0,
      error: lastError?.message || 'All strategies failed'
    });

    vpn.trackDownload({ bytes: 0, failed: true }).catch(() => {});

    return { success: false, error: lastError?.message };
  } finally {
    activeDownloads.delete(downloadId);
  }
}

app.post('/api/download', async (req, res) => {
  const { urls, mediaType, settings, showName, seasonNumber, startEpisode, endEpisode, movieName, movieYear } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'No URLs provided' });
  }

  const options = {
    mediaType,
    settings: settings || {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      retries: 3
    },
    showName,
    seasonNumber,
    startEpisode,
    endEpisode,
    movieName,
    movieYear
  };

  res.json({ message: 'Download started', count: urls.length });

  manualJobActive = true;
  (async () => {
    const results = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const result = await downloadUrl(urls[i], options, i, urls.length);
        results.push(result);
      } catch (err) {
        console.error(`Error downloading URL ${i}:`, err);
        results.push({ success: false, error: err.message });
      }
    }

    const successful = results.filter(r => r.success).length;
    broadcast({
      type: 'complete',
      message: `Completed: ${successful}/${urls.length} successful`,
      results
    });
  })();
});

async function probeStream(url, cookie, referer) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
    ];
    if (referer || cookie) {
      let headers = '';
      if (referer) headers += `Referer: ${referer}\r\n`;
      if (cookie) headers += `Cookie: ${cookie}\r\n`;
      args.push('-headers', headers);
    }
    args.push('-timeout', '8000000');  // 8 seconds in microseconds
    args.push(url);

    const ffprobe = spawnWithVpn('ffprobe', args);
    let out = '';
    ffprobe.stdout.on('data', d => { out += d.toString(); });
    ffprobe.on('close', () => {
      try {
        const data = JSON.parse(out);
        const video = (data.streams || []).find(s => s.codec_type === 'video');
        const audio = (data.streams || []).find(s => s.codec_type === 'audio');
        const fmt = data.format || {};
        const result = {};
        if (video) {
          result.resolution = `${video.width}x${video.height}`;
          result.videoCodec = video.codec_name;
          if (video.height >= 1080) result.quality = '1080p';
          else if (video.height >= 720) result.quality = '720p';
          else if (video.height >= 480) result.quality = '480p';
          else if (video.height) result.quality = `${video.height}p`;
        }
        if (audio) result.audioCodec = audio.codec_name;
        if (fmt.duration) result.duration = Math.round(parseFloat(fmt.duration));
        if (fmt.size) result.size = Math.round(parseInt(fmt.size) / 1024 / 1024) + ' MB';
        if (fmt.bit_rate) result.bitrate = Math.round(parseInt(fmt.bit_rate) / 1000) + ' kbps';
        resolve(Object.keys(result).length ? result : null);
      } catch {
        resolve(null);
      }
    });
    ffprobe.on('error', () => resolve(null));
    setTimeout(() => { ffprobe.kill(); resolve(null); }, 10000);
  });
}

// Browser-based stream detection — shared by /api/detect-stream and /api/bulk-download
async function detectPageStreams(pageUrl) {
  let browser;
  try {
    broadcast({ type: 'detect-status', message: 'Launching browser...' });
    console.log('detect-stream: opening', pageUrl);

    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ]
    });
    const contextOptions = {
      userAgent: BROWSER_USER_AGENT,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
    };
    const playwrightProxy = vpn.getPlaywrightProxy();
    if (playwrightProxy) contextOptions.proxy = playwrightProxy;
    const context = await browser.newContext(contextOptions);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const detectedUrls = new Set();
    const detected = [];

    function isStreamUrl(url) {
      return /\.m3u8(\?|$)/.test(url) ||
             /\.mpd(\?|$)/.test(url) ||
             /\.mp4(\?|$)/.test(url);
    }

    function extractStreamUrls(text) {
      const found = [];
      const pattern = /https?:\\?\/\\?\/[^\s"'<>]+?(?:\.m3u8|\.mpd|\.mp4)(?:[^\s"'<>]*)?/g;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const url = m[0].replace(/\\\//g, '/').replace(/\\u002[Ff]/g, '/');
        if (!found.includes(url)) found.push(url);
      }
      return found;
    }

    // Known high-quality CDN domains — these are prioritized when sorting before probing
    const PRIORITY_DOMAINS = ['valhallastream', 'valhalla', 'vidsrc', 'embedsito', 'febbox'];

    function streamPriority(url) {
      return PRIORITY_DOMAINS.some(d => url.includes(d)) ? 0 : 1;
    }

    function addDetected(url, label) {
      if (detected.length >= 50) return; // collect broadly; we prioritize+cap before probing
      if (!detectedUrls.has(url)) {
        detectedUrls.add(url);
        detected.push({ url });
        console.log(`detect-stream: found via ${label}:`, url);
        broadcast({ type: 'detect-status', message: `Found stream: ${url.substring(0, 100)}` });
      }
    }

    context.on('request', request => {
      const url = request.url();
      if (isStreamUrl(url)) addDetected(url, 'request');
    });

    context.on('response', async response => {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('javascript') || ct.includes('text/plain')) {
          const body = await response.text().catch(() => '');
          const found = extractStreamUrls(body);
          for (const u of found) addDetected(u, 'response-body');
        }
      } catch {}
    });

    const page = await context.newPage();

    broadcast({ type: 'detect-status', message: 'Opening page...' });
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      console.log('detect-stream: goto warning:', e.message);
    }

    broadcast({ type: 'detect-status', message: 'Page loaded, looking for player...' });
    await page.waitForTimeout(2000);

    const playSelectors = [
      '.vjs-big-play-button',
      '.jw-icon-display',
      '.plyr__control--overlaid',
      '[aria-label*="play" i]',
      '[title*="play" i]',
      'button[class*="play"]',
      '.play-button',
      'video',
    ];

    async function tryClick(frame) {
      for (const sel of playSelectors) {
        try {
          await frame.click(sel, { timeout: 800, force: true });
          console.log('detect-stream: clicked', sel, 'in frame', frame.url());
          return;
        } catch {}
      }
    }

    await tryClick(page);
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) await tryClick(frame);
    }

    broadcast({ type: 'detect-status', message: 'Waiting for stream to load...' });
    await page.waitForTimeout(4000);

    // Second pass — iframes may have loaded more content by now
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) await tryClick(frame);
    }
    await page.waitForTimeout(2000);

    if (detected.length === 0) {
      broadcast({ type: 'detect-status', message: 'Trying embedded players...' });
      const iframeSrcs = await page.evaluate(() =>
        [...document.querySelectorAll('iframe')]
          .map(f => f.src)
          .filter(s => s && s.startsWith('http') && !s.includes('google') && !s.includes('facebook') && !s.includes('recaptcha') && !s.includes('twitter'))
      );
      console.log('detect-stream: iframe srcs found:', iframeSrcs);

      for (const src of iframeSrcs.slice(0, 5)) {
        const embedPage = await context.newPage();
        try {
          await embedPage.goto(src, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await embedPage.waitForTimeout(2000);
          await tryClick(embedPage);
          for (const frame of embedPage.frames()) {
            if (frame !== embedPage.mainFrame()) await tryClick(frame);
          }
          await embedPage.waitForTimeout(4000);
        } catch (e) {
          console.log('detect-stream: iframe page error:', e.message);
        }
        await embedPage.close();
        if (detected.length > 0) break;
      }
    }

    const cookies = await context.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    browser = null;

    if (detected.length === 0) {
      return { streams: [], cookieString, userAgent: BROWSER_USER_AGENT };
    }

    const labeled = detected.map(d => ({
      url: d.url,
      type: d.url.includes('.m3u8') ? 'm3u8' : d.url.includes('.mpd') ? 'dash' : 'mp4'
    }));
    // Sort: priority domains first, then by type (m3u8 > dash > mp4)
    labeled.sort((a, b) => {
      const pa = streamPriority(a.url), pb = streamPriority(b.url);
      if (pa !== pb) return pa - pb;
      const order = { m3u8: 0, dash: 1, mp4: 2 };
      return order[a.type] - order[b.type];
    });

    // Cap before probing — prevents spawning too many simultaneous ffprobe processes
    const MAX_STREAMS = 5;
    const capped = labeled.slice(0, MAX_STREAMS);
    if (labeled.length > MAX_STREAMS) {
      console.log(`detect-stream: capping ${labeled.length} streams to ${MAX_STREAMS} before probing`);
    }

    broadcast({ type: 'detect-status', message: 'Probing stream quality...' });
    await Promise.all(capped.map(async stream => {
      try {
        const info = await probeStream(stream.url, cookieString, pageUrl);
        if (info) Object.assign(stream, info);
      } catch {}
    }));
    labeled.length = 0;
    labeled.push(...capped);

    // Deduplicate by filename — same MP4 may appear via direct request and response body with different query params
    const byFilename = new Map();
    for (const stream of labeled) {
      let key;
      try {
        key = new URL(stream.url).pathname.split('/').pop() || stream.url;
      } catch {
        key = stream.url;
      }
      if (byFilename.has(key)) {
        const existing = byFilename.get(key);
        // Prefer the entry that was successfully probed (URL known to be accessible)
        if (!existing.quality && stream.quality) Object.assign(existing, stream);
      } else {
        byFilename.set(key, stream);
      }
    }

    const streams = [...byFilename.values()];
    console.log('detect-stream: found streams:', streams.map(s => `[${s.type}] ${s.resolution || '?'} ${s.url.substring(0, 60)}`));

    return { streams, cookieString, userAgent: BROWSER_USER_AGENT };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

app.post('/api/detect-stream', async (req, res) => {
  const { pageUrl, requiredDomain } = req.body;
  if (!pageUrl) return res.status(400).json({ error: 'No pageUrl provided' });

  const maxAttempts = requiredDomain ? 5 : 1;

  try {
    let streams, cookieString, userAgent;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        broadcast({ type: 'detect-status', message: `Required domain "${requiredDomain}" not found — retrying (attempt ${attempt}/${maxAttempts})...` });
        await new Promise(r => setTimeout(r, 2000));
      }

      const result = await detectPageStreams(pageUrl);
      streams = result.streams;
      cookieString = result.cookieString;
      userAgent = result.userAgent;

      if (!requiredDomain) break;
      const found = streams.some(s => s.url.includes(requiredDomain));
      if (found) {
        if (attempt > 1) broadcast({ type: 'detect-status', message: `Found "${requiredDomain}" stream on attempt ${attempt}` });
        break;
      }
      if (attempt === maxAttempts) {
        broadcast({ type: 'detect-status', message: `Could not find "${requiredDomain}" stream after ${maxAttempts} attempts` });
      }
    }

    if (!streams.length) {
      return res.status(404).json({
        error: 'No stream URLs detected on this page',
        hint: 'The player may require interaction or use an unsupported protocol'
      });
    }

    res.json({ streams, cookie: cookieString, referer: pageUrl, userAgent });
  } catch (err) {
    console.error('detect-stream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetches a URL and returns parsed JSON, with a timeout
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': BROWSER_USER_AGENT } }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// TMDB API key extracted from Rivestream's public network traffic (visible in browser devtools)
const TMDB_API_KEY = 'd64117f26031a428449f102ced3aba73';

// Fast path: extract show ID from a Rivestream URL and query TMDB directly
async function getShowInfoFromTmdb(showId) {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/tv/${showId}?language=en-US&api_key=${TMDB_API_KEY}`
  );
  if (!data.seasons) throw new Error('No seasons in TMDB response');

  const seasons = data.seasons
    .filter(s => s.season_number > 0 && s.episode_count > 0) // skip specials (season 0)
    .sort((a, b) => a.season_number - b.season_number)
    .map(s => ({ season: s.season_number, startEpisode: 1, endEpisode: s.episode_count }));

  return { mediaType: 'tv', seasons, showName: data.name || null };
}

async function getMovieInfoFromTmdb(movieId) {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/movie/${movieId}?language=en-US&api_key=${TMDB_API_KEY}`
  );
  const movieName = data.title || null;
  const movieYear = data.release_date ? parseInt(data.release_date.substring(0, 4)) : null;
  return { mediaType: 'movie', movieName, movieYear };
}

// Slow path: open the page with a browser, intercept JSON API responses, extract season info
async function getShowInfoViaBrowser(pageUrl) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    });
    const showInfoContextOptions = {
      userAgent: BROWSER_USER_AGENT, viewport: { width: 1280, height: 720 }, locale: 'en-US',
    };
    const showInfoProxy = vpn.getPlaywrightProxy();
    if (showInfoProxy) showInfoContextOptions.proxy = showInfoProxy;
    const context = await browser.newContext(showInfoContextOptions);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const capturedJson = [];
    context.on('response', async response => {
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const text = await response.text().catch(() => '');
        if (!text || text.length > 500_000) return;
        capturedJson.push(JSON.parse(text));
      } catch {}
    });

    const page = await context.newPage();
    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 22000 });
    } catch (e) {
      console.log('show-info browser: load warning:', e.message.slice(0, 80));
    }
    await page.waitForTimeout(2000);

    // Sort larger payloads first (more likely to be show metadata)
    capturedJson.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
    for (const data of capturedJson) {
      const info = extractShowInfoFromData(data);
      if (info?.seasons?.length > 0) {
        await browser.close();
        return info;
      }
    }

    // Fallback: check Next.js page data embedded in the HTML
    const nextData = await page.evaluate(() => {
      const el = document.querySelector('#__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    }).catch(() => null);

    await browser.close();
    browser = null;

    if (nextData) {
      const info = extractShowInfoFromData(nextData);
      if (info?.seasons?.length > 0) return info;
    }

    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

app.post('/api/show-info', async (req, res) => {
  const { baseUrl } = req.body;
  if (!baseUrl) return res.status(400).json({ error: 'Missing baseUrl' });

  try {
    let parsedUrl;
    try { parsedUrl = new URL(baseUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    // Fast path: Rivestream uses TMDB IDs — query TMDB API directly, no browser needed
    const showId = parsedUrl.searchParams.get('id');
    if (showId && parsedUrl.hostname.includes('rivestream')) {
      const type = parsedUrl.searchParams.get('type') || 'tv';
      const seasonParam = parsedUrl.searchParams.get('season');
      const episodeParam = parsedUrl.searchParams.get('episode');
      if (type === 'movie') {
        console.log('show-info: fast TMDB movie lookup for id', showId);
        const info = await getMovieInfoFromTmdb(showId);
        console.log(`show-info: movie ${info.movieName} (${info.movieYear})`);
        return res.json(info);
      }
      console.log('show-info: fast TMDB lookup for id', showId);
      const info = await getShowInfoFromTmdb(showId);
      console.log(`show-info: ${info.showName} — ${info.seasons.length} seasons`);
      return res.json({
        ...info,
        ...(seasonParam ? { season: parseInt(seasonParam) } : {}),
        ...(episodeParam ? { episode: parseInt(episodeParam) } : {}),
      });
    }

    // Slow path: open the page with a browser and intercept API calls
    console.log('show-info: browser fallback for', baseUrl);
    const info = await getShowInfoViaBrowser(baseUrl);
    if (info?.seasons?.length > 0) {
      console.log('show-info: found via browser:', info.seasons.length, 'seasons');
      return res.json(info);
    }

    res.status(404).json({
      error: 'Could not detect season/episode info from this page.',
      hint: 'For Rivestream, make sure the URL contains ?type=tv&id=<tmdb_id>. Run explore-rivestream.js for debugging.',
    });
  } catch (err) {
    console.error('show-info error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Core bulk download loop, shared by /api/bulk-download and the follow-show checker.
async function runBulkEpisodes({ showId, showName, seasons, quality, retries = 3, requiredDomain, labelPrefix = '' }) {
  const totalEpisodes = seasons.reduce((sum, s) => sum + (s.endEpisode - s.startEpisode + 1), 0);
  const pfx = labelPrefix ? `[${labelPrefix}] ` : '';
  bulkJobActive = true;
  let completed = 0, failed = 0, episodeNum = 0;

  for (const { season, startEpisode, endEpisode } of seasons) {
    for (let ep = startEpisode; ep <= endEpisode; ep++) {
      episodeNum++;
      const epLabel = `S${String(season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`;
      const episodeUrl = `https://rivestream.org/watch?type=tv&id=${showId}&season=${season}&episode=${ep}`;

      broadcast({
        type: 'bulk-status',
        message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — detecting stream...`,
        episode: epLabel, current: episodeNum, total: totalEpisodes,
      });

      try {
        let streams = [], cookieString, userAgent;
        let downloadResult = null;
        let detectionFailed = false;

        // Per-episode VPN rotation:
        //   - try up to retriesPerVpn times on the current VPN for detection
        //   - if required domain still not found → switch VPN and retry detection
        //   - if download itself fails → also switch VPN and retry detection + download
        //   - give up after maxVpnSwitches total switches
        const dr = vpn.settings.detectionRotate || {};
        const baseRetries     = requiredDomain ? 5 : 1;
        const retriesPerVpn   = vpn.activeConfig ? (parseInt(dr.retriesPerVpn)  || baseRetries) : baseRetries;
        const maxVpnSwitches  = vpn.activeConfig ? (parseInt(dr.maxVpnSwitches) || 0)           : 0;
        const triedVpns = vpn.activeConfig ? [vpn.activeConfig] : [];
        let vpnSwitchCount = 0;

        episodeLoop: while (true) {
          streams = []; cookieString = undefined; userAgent = undefined;
          detectionFailed = false;

          // Detection phase — retry up to retriesPerVpn times on the current VPN
          for (let attempt = 1; attempt <= retriesPerVpn; attempt++) {
            if (attempt > 1) {
              broadcast({
                type: 'bulk-status',
                message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — "${requiredDomain}" not found, retrying (${attempt}/${retriesPerVpn})...`,
                episode: epLabel, current: episodeNum, total: totalEpisodes,
              });
              await new Promise(r => setTimeout(r, 2000));
            }
            const result = await detectPageStreams(episodeUrl);
            streams = result.streams; cookieString = result.cookieString; userAgent = result.userAgent;
            if (!requiredDomain || streams.some(s => s.url.includes(requiredDomain))) break;
          }

          // Detection failure — maybe switch VPN
          if (!streams.length || (requiredDomain && !streams.some(s => s.url.includes(requiredDomain)))) {
            detectionFailed = true;
            if (maxVpnSwitches > 0 && vpnSwitchCount < maxVpnSwitches) {
              const nextVpn = await vpn.getNextForDetection(triedVpns);
              if (nextVpn) {
                broadcast({
                  type: 'bulk-status',
                  message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — switching VPN to "${nextVpn}" for detection (${vpnSwitchCount + 1}/${maxVpnSwitches})...`,
                  episode: epLabel, current: episodeNum, total: totalEpisodes,
                });
                await vpn.activate(nextVpn).catch(err => console.error(`[VPN] Switch to ${nextVpn} failed: ${err.message}`));
                triedVpns.push(nextVpn);
                vpnSwitchCount++;
                continue episodeLoop;
              }
            }
            break; // No more VPNs to try
          }

          // Download phase
          const stream = pickStream(streams, quality);
          const qualityLabel = stream.quality || stream.resolution || stream.type;
          broadcast({
            type: 'bulk-status',
            message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — downloading ${qualityLabel}...`,
            episode: epLabel, current: episodeNum, total: totalEpisodes,
          });

          downloadResult = await downloadUrl(stream.url, {
            mediaType: 'tv',
            settings: { cookie: cookieString, userAgent, referer: episodeUrl, retries },
            showName, seasonNumber: season, startEpisode: ep,
          }, 0, 1);

          if (downloadResult.success) break episodeLoop; // done!

          // Download failed — maybe switch VPN and retry
          if (maxVpnSwitches > 0 && vpnSwitchCount < maxVpnSwitches) {
            const nextVpn = await vpn.getNextForDetection(triedVpns);
            if (nextVpn) {
              broadcast({
                type: 'bulk-status',
                message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — download failed, switching VPN to "${nextVpn}" (${vpnSwitchCount + 1}/${maxVpnSwitches})...`,
                episode: epLabel, current: episodeNum, total: totalEpisodes,
              });
              await vpn.activate(nextVpn).catch(err => console.error(`[VPN] Switch to ${nextVpn} failed: ${err.message}`));
              triedVpns.push(nextVpn);
              vpnSwitchCount++;
              continue episodeLoop;
            }
          }
          break; // All VPNs exhausted
        }

        if (downloadResult?.success) {
          completed++;
        } else {
          if (detectionFailed && !streams.length) {
            broadcast({ type: 'bulk-status', message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — no streams found`, episode: epLabel, error: true });
          } else if (detectionFailed) {
            broadcast({ type: 'bulk-status', message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — required domain not found after retries`, episode: epLabel, error: true });
          }
          // download failure broadcast already emitted by downloadUrl
          failed++;
        }

      } catch (err) {
        console.error(`Bulk download error for ${epLabel}:`, err.message);
        broadcast({
          type: 'bulk-status',
          message: `${pfx}[${episodeNum}/${totalEpisodes}] ${epLabel} — error: ${err.message}`,
          episode: epLabel, error: true,
        });
        failed++;
      }
    }
  }

  broadcast({
    type: 'bulk-complete',
    message: `${pfx}Download complete: ${completed}/${totalEpisodes} successful`,
    completed, failed, total: totalEpisodes,
  });

  return { completed, failed, total: totalEpisodes };
}

app.post('/api/bulk-download', async (req, res) => {
  const { baseUrl, seasons, quality, showName, retries = 3, requiredDomain } = req.body;

  if (!baseUrl || !seasons?.length || !showName) {
    return res.status(400).json({ error: 'Missing required fields: baseUrl, seasons, showName' });
  }

  let showId;
  try {
    showId = new URL(baseUrl).searchParams.get('id');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!showId) return res.status(400).json({ error: 'Could not extract show ID from URL' });

  const totalEpisodes = seasons.reduce((sum, s) => sum + (s.endEpisode - s.startEpisode + 1), 0);
  res.json({ message: 'Bulk download started', totalEpisodes });

  runBulkEpisodes({ showId, showName, seasons, quality, retries, requiredDomain }).catch(err => {
    broadcast({ type: 'bulk-complete', message: 'Bulk download failed: ' + err.message, completed: 0, failed: 0, total: totalEpisodes });
  });
});

// ── Follow Show ─────────────────────────────────────────────────────────────
const FOLLOWED_SHOWS_FILE = path.join(__dirname, 'data', 'followed-shows.json');
let followedShows = [];
const followCheckStatus = new Map(); // id -> { message, checking }
const pendingFollowDownloads = [];   // { show, seasons }[] queued while bulkJobActive
let followQueueRunning = false;

async function loadFollowedShows() {
  try {
    await fs.mkdir(path.dirname(FOLLOWED_SHOWS_FILE), { recursive: true });
    const text = await fs.readFile(FOLLOWED_SHOWS_FILE, 'utf8');
    followedShows = JSON.parse(text);
  } catch {
    followedShows = [];
  }
}

async function saveFollowedShows() {
  await fs.mkdir(path.dirname(FOLLOWED_SHOWS_FILE), { recursive: true });
  await fs.writeFile(FOLLOWED_SHOWS_FILE, JSON.stringify(followedShows, null, 2));
}

function serializeFollowedShows() {
  return followedShows.map(s => ({ ...s, status: followCheckStatus.get(s.id) || null }));
}

function broadcastFollowedShows() {
  broadcast({ type: 'followed-shows', shows: serializeFollowedShows() });
}

async function processFollowQueue() {
  if (followQueueRunning) return;
  followQueueRunning = true;
  while (pendingFollowDownloads.length > 0) {
    while (bulkJobActive) await new Promise(r => setTimeout(r, 5000));
    const { show, seasons } = pendingFollowDownloads.shift();
    const showIdMatch = show.url.match(/[?&]id=(\d+)/);
    if (!showIdMatch) continue;
    try {
      const { completed, failed, total } = await runBulkEpisodes({
        showId: showIdMatch[1],
        showName: show.name,
        seasons,
        quality: show.quality || 'best',
        retries: 5,
        requiredDomain: 'valhallastream',
        labelPrefix: show.name,
      });
      followCheckStatus.set(show.id, {
        message: `Downloaded ${completed}/${total} new episode${total !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`,
        checking: false,
      });
    } catch (err) {
      followCheckStatus.set(show.id, { message: `Download failed: ${err.message}`, checking: false });
    }
    broadcastFollowedShows();
  }
  followQueueRunning = false;
}

async function checkFollowedShow(show) {
  if (followCheckStatus.get(show.id)?.checking) return;
  followCheckStatus.set(show.id, { message: 'Checking for new episodes...', checking: true });
  broadcastFollowedShows();

  try {
    const info = await getShowInfoFromTmdb(show.tmdbId);
    const newSeasons = [];

    for (const s of info.seasons) {
      const known = show.knownEpisodeCounts[String(s.season)] || 0;
      if (s.endEpisode > known) {
        newSeasons.push({ season: s.season, startEpisode: known + 1, endEpisode: s.endEpisode });
        show.knownEpisodeCounts[String(s.season)] = s.endEpisode;
      }
    }
    show.lastChecked = new Date().toISOString();

    if (newSeasons.length === 0) {
      followCheckStatus.set(show.id, { message: 'Up to date', checking: false });
    } else {
      const count = newSeasons.reduce((s, n) => s + n.endEpisode - n.startEpisode + 1, 0);
      followCheckStatus.set(show.id, {
        message: `Found ${count} new episode${count !== 1 ? 's' : ''} — queued for download`,
        checking: false,
      });
      pendingFollowDownloads.push({ show, seasons: newSeasons });
      processFollowQueue();
    }

    await saveFollowedShows();
    broadcastFollowedShows();
  } catch (err) {
    show.lastChecked = new Date().toISOString();
    followCheckStatus.set(show.id, { message: `Check failed: ${err.message}`, checking: false });
    await saveFollowedShows();
    broadcastFollowedShows();
  }
}

// Periodic check — every 30 minutes, check any shows whose interval has elapsed
setInterval(() => {
  const now = Date.now();
  for (const show of followedShows) {
    const lastChecked = show.lastChecked ? new Date(show.lastChecked).getTime() : 0;
    const intervalMs = (show.checkIntervalHours || 6) * 60 * 60 * 1000;
    if (now - lastChecked >= intervalMs) {
      checkFollowedShow(show).catch(e => console.error('Follow auto-check error:', e.message));
    }
  }
}, 30 * 60 * 1000);

app.get('/api/followed-shows', (req, res) => {
  res.json(serializeFollowedShows());
});

app.post('/api/followed-shows', async (req, res) => {
  const { url, name, quality = 'best', checkIntervalHours = 6, downloadExisting = false } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const tmdbId = parsedUrl.searchParams.get('id');
  if (!tmdbId) return res.status(400).json({ error: 'Could not extract TMDB ID from URL (expected ?id=...)' });
  if (followedShows.find(s => s.tmdbId === tmdbId)) return res.status(409).json({ error: 'This show is already being followed' });

  try {
    const info = await getShowInfoFromTmdb(tmdbId);
    const showName = name?.trim() || info.showName || 'Unknown Show';
    const show = {
      id: `${tmdbId}-${Date.now()}`,
      name: showName,
      url,
      tmdbId,
      quality,
      checkIntervalHours,
      addedAt: new Date().toISOString(),
      lastChecked: null,
      // If not downloading existing, mark everything currently known so only future eps are downloaded
      knownEpisodeCounts: downloadExisting
        ? {}
        : Object.fromEntries(info.seasons.map(s => [String(s.season), s.endEpisode])),
      totalSeasons: info.seasons.length,
      totalEpisodes: info.seasons.reduce((sum, s) => sum + s.endEpisode, 0),
    };

    followedShows.push(show);
    await saveFollowedShows();
    broadcastFollowedShows();
    res.json({ show, info });

    if (downloadExisting) {
      pendingFollowDownloads.push({ show, seasons: info.seasons });
      processFollowQueue();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/followed-shows/:id', async (req, res) => {
  const idx = followedShows.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Show not found' });
  followedShows.splice(idx, 1);
  followCheckStatus.delete(req.params.id);
  await saveFollowedShows();
  broadcastFollowedShows();
  res.json({ ok: true });
});

app.post('/api/followed-shows/:id/check', (req, res) => {
  const show = followedShows.find(s => s.id === req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  res.json({ ok: true });
  checkFollowedShow(show).catch(e => console.error('Manual check error:', e.message));
});

// ── VPN ─────────────────────────────────────────────────────────────────────

app.get('/api/vpn/configs', async (req, res) => {
  const configs = await vpn.listConfigs();
  res.json({ configs });
});

app.get('/api/vpn/status', (req, res) => {
  res.json(vpn.getStatus());
});

app.post('/api/vpn/activate', async (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'Missing config name' });
  try {
    await vpn.activate(config);
    vpn.settings.selectedConfig = config;
    await vpn.saveSettings();
    res.json(vpn.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vpn/deactivate', async (req, res) => {
  try {
    await vpn.deactivate();
    vpn.settings.selectedConfig = null;
    await vpn.saveSettings();
    res.json(vpn.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/vpn/settings', async (req, res) => {
  const { onFailureCount, onGbDownloaded, detectionRotate } = req.body;
  vpn.settings.autoRotate = {
    onFailureCount: parseInt(onFailureCount) || 0,
    onGbDownloaded: parseFloat(onGbDownloaded) || 0,
  };
  if (detectionRotate) {
    vpn.settings.detectionRotate = {
      retriesPerVpn:  parseInt(detectionRotate.retriesPerVpn)  || 3,
      maxVpnSwitches: parseInt(detectionRotate.maxVpnSwitches) || 0,
      selectionMode:  ['sequential', 'random', 'priority'].includes(detectionRotate.selectionMode)
                        ? detectionRotate.selectionMode : 'sequential',
      priorityList: Array.isArray(detectionRotate.priorityList) ? detectionRotate.priorityList : [],
    };
  }
  await vpn.saveSettings();
  res.json(vpn.getStatus());
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeDownloads: activeDownloads.size });
});

app.get('/api/check-deps', (req, res) => {
  res.json({
    ytdlp: deps.ytDlp,
    ffmpeg: deps.ffmpeg,
    ready: deps.ffmpeg
  });
});

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Restore active job state for reconnecting clients
  if (downloadProgress.size > 0 || bulkJobActive || manualJobActive) {
    for (const progress of downloadProgress.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(progress));
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'session-state',
        isProcessing: manualJobActive,
        isBulkProcessing: bulkJobActive,
        bulkStatus: currentBulkState?.message || null,
        bulkProgress: (currentBulkState?.current && currentBulkState?.total)
          ? { current: currentBulkState.current, total: currentBulkState.total }
          : null,
      }));
    }
  }

  // Send current followed-shows list so new clients are up to date
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'followed-shows', shows: serializeFollowedShows() }));
  }

  // Send current VPN status
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'vpn-status', ...vpn.getStatus() }));
  }

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access from LAN: http://<server-ip>:${PORT}`);
  console.log('\nChecking dependencies...');

  (async () => {
    await fs.mkdir(TEMP_DOWNLOAD_DIR, { recursive: true }).catch(() => {});
    await loadFollowedShows();
    console.log(`  Followed shows: ${followedShows.length} loaded`);

    deps.ytDlp = await commandExists('yt-dlp');
    deps.ffmpeg = await commandExists('ffmpeg');

    console.log(`  yt-dlp: ${deps.ytDlp ? '✓' : '✗ (optional but recommended)'}`);
    console.log(`  ffmpeg: ${deps.ffmpeg ? '✓' : '✗ (required)'}`);

    if (!deps.ffmpeg) {
      console.log('\n⚠️  WARNING: ffmpeg is not installed! Downloader will not work.');
    }
    if (!deps.ytDlp) {
      console.log('\n💡 TIP: Install yt-dlp for better compatibility with difficult sources');
      console.log('   pip install yt-dlp');
    }

    // VPN init: clean up stale state, load settings, and auto-connect if previously active
    await vpn.init();
    if (vpn.settings.selectedConfig) {
      console.log(`[VPN] Auto-connecting to saved profile: ${vpn.settings.selectedConfig}`);
      vpn.activate(vpn.settings.selectedConfig).catch(err => {
        console.error(`[VPN] Auto-connect failed: ${err.message}`);
      });
    }
  })();
});

// Clean up VPN namespace when the process exits
async function shutdownVpn() {
  await vpn.deactivate().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdownVpn);
process.on('SIGINT', shutdownVpn);
