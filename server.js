const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const https = require('https');
const http = require('http');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());
app.use(express.static('public'));

// Create HTTP server
const server = require('http').createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

const activeDownloads = new Map();

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Format seconds to HH:MM:SS
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Parse ffmpeg progress output
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

// Create Jellyfin-compatible filename
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

// Create Jellyfin-compatible directory path
function createDirectoryPath(options) {
  if (options.mediaType === 'tv') {
    const { showName, seasonNumber } = options;
    return `/mnt/nas/shows/${showName}/Season ${String(seasonNumber).padStart(2, '0')}`;
  } else {
    const { movieName, movieYear } = options;
    return `/mnt/nas/movies/${movieName} (${movieYear})`;
  }
}

// Check if command exists
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

// Strategy 1: yt-dlp (most reliable)
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

  // Add headers
  if (options.settings.userAgent) {
    args.push('--user-agent', options.settings.userAgent);
  }
  if (options.settings.referer) {
    args.push('--referer', options.settings.referer);
  }
  if (options.settings.cookie) {
    args.push('--add-header', `Cookie: ${options.settings.cookie}`);
  }

  // Progress reporting
  args.push('--newline', '--progress');

  args.push(url);

  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', args);
    let lastProgress = 0;

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Parse yt-dlp progress
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

// Strategy 2: Enhanced ffmpeg with HLS-specific options
async function downloadWithEnhancedFfmpeg(url, outputPath, options, downloadId, filename) {
  console.log('Attempting download with enhanced ffmpeg...');
  
  const tempDir = '/tmp/hls_downloads';
  await fs.mkdir(tempDir, { recursive: true });
  const progressFile = path.join(tempDir, `${downloadId}.progress`);

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'info',
  ];

  // User agent
  if (options.settings.userAgent) {
    args.push('-user_agent', options.settings.userAgent);
  }

  // Headers
  if (options.settings.referer || options.settings.cookie) {
    let headers = '';
    if (options.settings.referer) {
      headers += `Referer: ${options.settings.referer}\r\n`;
    }
    if (options.settings.cookie) {
      headers += `Cookie: ${options.settings.cookie}\r\n`;
    }
    args.push('-headers', headers);
  }

  // HLS-specific options
  args.push(
    '-allowed_extensions', 'ALL',  // Allow all segment types
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  );

  args.push('-i', url);

  // Try to preserve original codecs first
  args.push(
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-bsf:a', 'aac_adtstoasc',  // Fix AAC streams
    '-y',
    outputPath,
    '-progress', progressFile
  );

  return new Promise(async (resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let totalDuration = 0;
    let stderr = '';

    // Try to get duration
    try {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        url
      ]);

      let durationOutput = '';
      ffprobe.stdout.on('data', data => {
        durationOutput += data.toString();
      });

      await new Promise((res) => {
        ffprobe.on('close', () => {
          const duration = parseFloat(durationOutput.trim());
          if (!isNaN(duration)) {
            totalDuration = duration;
          }
          res();
        });
      });
    } catch (err) {
      console.log('Could not determine duration');
    }

    // Monitor progress
    const progressMonitor = setInterval(async () => {
      try {
        const progressData = await fs.readFile(progressFile, 'utf8');
        const progress = parseProgress(progressData);

        let outSeconds = 0;
        if (progress.out_time_ms) {
          outSeconds = parseInt(progress.out_time_ms) / 1000000;
        } else if (progress.out_time) {
          const parts = progress.out_time.split(':');
          outSeconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
        }

        let percentage = 0;
        let eta = 'unknown';
        
        if (totalDuration > 0 && outSeconds > 0) {
          percentage = (outSeconds / totalDuration) * 100;
          const speed = parseFloat(progress.speed || 1);
          const remaining = totalDuration - outSeconds;
          const etaSeconds = speed > 0 ? remaining / speed : remaining;
          eta = formatTime(etaSeconds);
        }

        broadcast({
          type: 'progress',
          id: downloadId,
          filename,
          url,
          status: 'downloading',
          progress: Math.min(percentage, 100),
          speed: progress.speed ? `${progress.speed}x` : undefined,
          eta: eta !== 'unknown' ? eta : undefined,
          method: 'ffmpeg-enhanced'
        });
      } catch (err) {
        // Progress file not ready yet
      }
    }, 500);

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      clearInterval(progressMonitor);
      
      if (code === 0) {
        resolve(true);
      } else {
        // Check if it's a codec issue
        if (stderr.includes('codec') || stderr.includes('Codec')) {
          reject(new Error('CODEC_COPY_FAILED'));
        } else {
          reject(new Error(`ffmpeg failed with code ${code}`));
        }
      }
    });
  });
}

// Strategy 3: ffmpeg with re-encoding (slower but more compatible)
async function downloadWithReencoding(url, outputPath, options, downloadId, filename) {
  console.log('Attempting download with re-encoding...');
  
  const tempDir = '/tmp/hls_downloads';
  await fs.mkdir(tempDir, { recursive: true });
  const progressFile = path.join(tempDir, `${downloadId}.progress`);

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'info',
  ];

  if (options.settings.userAgent) {
    args.push('-user_agent', options.settings.userAgent);
  }

  if (options.settings.referer || options.settings.cookie) {
    let headers = '';
    if (options.settings.referer) {
      headers += `Referer: ${options.settings.referer}\r\n`;
    }
    if (options.settings.cookie) {
      headers += `Cookie: ${options.settings.cookie}\r\n`;
    }
    args.push('-headers', headers);
  }

  args.push(
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
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

        let outSeconds = 0;
        if (progress.out_time_ms) {
          outSeconds = parseInt(progress.out_time_ms) / 1000000;
        } else if (progress.out_time) {
          const parts = progress.out_time.split(':');
          outSeconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
        }

        if (progress.total_size && !totalDuration) {
          totalDuration = outSeconds * 1.1; // Estimate
        }

        let percentage = totalDuration > 0 ? (outSeconds / totalDuration) * 100 : 0;

        broadcast({
          type: 'progress',
          id: downloadId,
          filename,
          url,
          status: 'downloading',
          progress: Math.min(percentage, 99),
          speed: progress.speed ? `${progress.speed}x` : undefined,
          method: 'ffmpeg-reencode'
        });
      } catch (err) {
        // Progress file not ready yet
      }
    }, 1000);

    ffmpeg.on('close', (code) => {
      clearInterval(progressMonitor);
      
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`Re-encoding failed with code ${code}`));
      }
    });
  });
}

// Strategy 4: Direct mp4 download via wget (for proxy/direct mp4 URLs)
async function downloadWithWget(url, outputPath, options, downloadId, filename) {
  console.log('Attempting direct download with wget...');

  // Extract Referer/Origin from proxy URL's headers param if present
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

// Main download function with fallback strategies
async function downloadUrl(url, options, index, totalCount) {
  const filename = createFilename(options, index);
  const dirPath = createDirectoryPath(options);
  const outputPath = path.join(dirPath, filename);
  const downloadId = `${Date.now()}_${index}`;

  // Create directory if it doesn't exist
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    console.error('Error creating directory:', err);
    throw err;
  }

  // Check if file already exists
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

  // Check available tools
  const hasYtDlp = await commandExists('yt-dlp');
  const hasFfmpeg = await commandExists('ffmpeg');

  if (!hasFfmpeg) {
    throw new Error('ffmpeg is not installed');
  }

  broadcast({
    type: 'progress',
    id: downloadId,
    filename,
    url,
    status: 'starting',
    progress: 0
  });

  // Try strategies in order
  const strategies = [];
  
  const isDirectMp4 = /\.mp4(\?|$)/.test(url) || (url.includes('/proxy?') && url.includes('.mp4'));

  if (isDirectMp4) {
    // For direct mp4 files, try wget first (simpler, handles proxy URLs well)
    strategies.push({ name: 'wget', fn: () => downloadWithWget(url, outputPath, options, downloadId, filename) });
  }

  if (hasYtDlp) {
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
    // For direct mp4, ffmpeg copy is simpler than HLS-specific options
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
        
        // Success!
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
        
        // If codec copy failed, skip to re-encoding immediately
        if (err.message === 'CODEC_COPY_FAILED') {
          console.log('Codec copy failed, skipping to re-encoding...');
          break;
        }
        
        if (attempt < options.settings.retries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`Waiting ${delay/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  // All strategies failed
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
}

// API endpoint to start downloads
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

  // Process downloads sequentially
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

// Probe a stream URL with ffprobe to get resolution, codec, duration, size
async function probeStream(url, cookie, referer) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
    ];
    if (referer) args.push('-headers', `Referer: ${referer}\r\n`);
    if (cookie) args.push('-headers', `Cookie: ${cookie}\r\n`);
    // Short timeout so probing doesn't slow things down too much
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
    // Kill if takes too long
    setTimeout(() => { ffprobe.kill(); resolve(null); }, 10000);
  });
}

// Detect stream URL from a webpage using a real browser
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
    // Hide webdriver fingerprint
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const detected = [];
    const allUrls = [];

    function isStreamUrl(url) {
      return /\.m3u8(\?|$)/.test(url) ||
             /\.mpd(\?|$)/.test(url) ||
             /\.mp4(\?|$)/.test(url);
    }

    // Extract stream URLs from arbitrary text (JSON API responses, JS files, etc.)
    function extractStreamUrls(text) {
      const found = [];
      // Match raw and JSON-escaped URLs
      const pattern = /https?:\\?\/\\?\/[^\s"'<>]+?(?:\.m3u8|\.mpd|\.mp4)(?:[^\s"'<>]*)?/g;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        // Unescape JSON-escaped slashes
        const url = m[0].replace(/\\\//g, '/').replace(/\\u002[Ff]/g, '/');
        if (!found.includes(url)) found.push(url);
      }
      return found;
    }

    function addDetected(url, label) {
      if (!detected.find(d => d.url === url)) {
        detected.push({ url });
        console.log(`detect-stream: found via ${label}:`, url);
        broadcast({ type: 'detect-status', message: `Found stream: ${url.substring(0, 100)}` });
      }
    }

    // Intercept requests — catches direct stream loads
    context.on('request', request => {
      const url = request.url();
      allUrls.push(url);
      if (isStreamUrl(url)) addDetected(url, 'request');
    });

    // Intercept responses — catches stream URLs embedded in JSON/JS
    context.on('response', async response => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        // Only scan text-based responses (JSON, JS, plain text)
        if (ct.includes('json') || ct.includes('javascript') || ct.includes('text/plain')) {
          const body = await response.text().catch(() => '');
          const found = extractStreamUrls(body);
          for (const u of found) addDetected(u, 'response-body');
        }
      } catch {}
    });

    const page = await context.newPage();

    broadcast({ type: 'detect-status', message: `Opening page...` });
    try {
      // Use domcontentloaded — networkidle can hang forever on ad-heavy pages
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
      console.log('detect-stream: goto warning:', e.message);
    }

    broadcast({ type: 'detect-status', message: 'Page loaded, looking for player...' });
    await page.waitForTimeout(2000);

    // Try clicking common play button selectors on main page and all iframes
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

    // If still nothing found, open each iframe src directly — handles sites where
    // the player iframe is injected via JS (e.g. JWPlayer embed pages)
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

    // Grab cookies from the context
    const cookies = await context.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Log all urls seen for debugging
    console.log('detect-stream: total requests seen:', allUrls.length);
    const videoLike = allUrls.filter(u => isStreamUrl(u));
    console.log('detect-stream: stream-like urls:', videoLike);

    await browser.close();
    browser = null;

    if (detected.length === 0) {
      console.log('detect-stream: nothing found, sample of all URLs seen:',
        allUrls.filter(u => !u.startsWith('data:')).slice(-30));
      return res.status(404).json({
        error: 'No stream URLs detected on this page',
        hint: 'The player may require interaction or use an unsupported protocol'
      });
    }

    // Deduplicate and label by type — return ALL, let the user pick
    const unique = [...new Map(detected.map(d => [d.url, d])).values()];
    const labeled = unique.map(d => ({
      url: d.url,
      type: d.url.includes('.m3u8') ? 'm3u8' : d.url.includes('.mpd') ? 'dash' : 'mp4'
    }));
    // Sort: m3u8 first, then dash, then mp4
    labeled.sort((a, b) => {
      const order = { m3u8: 0, dash: 1, mp4: 2 };
      return order[a.type] - order[b.type];
    });

    // Probe each stream with ffprobe to get quality info (run in parallel, best-effort)
    broadcast({ type: 'detect-status', message: 'Probing stream quality...' });
    await Promise.all(labeled.map(async stream => {
      try {
        const info = await probeStream(stream.url, cookieString, pageUrl);
        if (info) Object.assign(stream, info);
      } catch {}
    }));

    console.log('detect-stream: returning streams:', labeled.map(s => `[${s.type}] ${s.resolution || '?'} ${s.url.substring(0, 60)}`));

    res.json({
      streams: labeled,
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeDownloads: activeDownloads.size });
});

// Check dependencies
app.get('/api/check-deps', async (req, res) => {
  const hasYtDlp = await commandExists('yt-dlp');
  const hasFfmpeg = await commandExists('ffmpeg');
  
  res.json({
    ytdlp: hasYtDlp,
    ffmpeg: hasFfmpeg,
    ready: hasFfmpeg
  });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access from LAN: http://<server-ip>:${PORT}`);
  console.log('\nChecking dependencies...');
  
  (async () => {
    const hasYtDlp = await commandExists('yt-dlp');
    const hasFfmpeg = await commandExists('ffmpeg');
    
    console.log(`  yt-dlp: ${hasYtDlp ? '✓' : '✗ (optional but recommended)'}`);
    console.log(`  ffmpeg: ${hasFfmpeg ? '✓' : '✗ (required)'}`);
    
    if (!hasFfmpeg) {
      console.log('\n⚠️  WARNING: ffmpeg is not installed! Downloader will not work.');
    }
    if (!hasYtDlp) {
      console.log('\n💡 TIP: Install yt-dlp for better compatibility with difficult sources');
      console.log('   pip install yt-dlp');
    }
  })();
});
