const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3003;
const TEMP_DOWNLOAD_DIR = '/tmp/hls_downloads';

app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const activeDownloads = new Map();
const deps = { ytDlp: false, ffmpeg: false };

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

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
    return `/mnt/nas/shows/${showName}/Season ${String(seasonNumber).padStart(2, '0')}`;
  } else {
    const { movieName, movieYear } = options;
    return `/mnt/nas/movies/${movieName} (${movieYear})`;
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
    const ytdlp = spawn('yt-dlp', args);
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
    const ffmpeg = spawn('ffmpeg', args);
    let totalDuration = 0;
    let stderr = '';

    // Fetch duration in parallel — updates totalDuration when it resolves
    const ffprobe = spawn('ffprobe', [
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
    const ffmpeg = spawn('ffmpeg', args);
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
    const wget = spawn('wget', args);
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

    if (isDirectMp4) {
      strategies.push({ name: 'wget', fn: () => downloadWithWget(url, outputPath, options, downloadId, filename) });
    }

    if (deps.ytDlp) {
      strategies.push({
        name: 'yt-dlp',
        fn: () => downloadWithYtDlp(url, outputPath, options, downloadId, filename)
      });
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

    const ffprobe = spawn('ffprobe', args);
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

app.post('/api/detect-stream', async (req, res) => {
  const { pageUrl } = req.body;
  if (!pageUrl) return res.status(400).json({ error: 'No pageUrl provided' });

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
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
    });
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

    function addDetected(url, label) {
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
      return res.status(404).json({
        error: 'No stream URLs detected on this page',
        hint: 'The player may require interaction or use an unsupported protocol'
      });
    }

    const labeled = detected.map(d => ({
      url: d.url,
      type: d.url.includes('.m3u8') ? 'm3u8' : d.url.includes('.mpd') ? 'dash' : 'mp4'
    }));
    labeled.sort((a, b) => {
      const order = { m3u8: 0, dash: 1, mp4: 2 };
      return order[a.type] - order[b.type];
    });

    broadcast({ type: 'detect-status', message: 'Probing stream quality...' });
    await Promise.all(labeled.map(async stream => {
      try {
        const info = await probeStream(stream.url, cookieString, pageUrl);
        if (info) Object.assign(stream, info);
      } catch {}
    }));

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
    const deduped = [...byFilename.values()];

    console.log('detect-stream: returning streams:', deduped.map(s => `[${s.type}] ${s.resolution || '?'} ${s.url.substring(0, 60)}`));

    res.json({
      streams: deduped,
      cookie: cookieString,
      referer: pageUrl,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('detect-stream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
  })();
});
