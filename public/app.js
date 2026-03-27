const { useState, useRef, useEffect } = React;

function Icon({ name, size = 20, className = '' }) {
  const icons = {
    download: '↓',
    plus: '+',
    x: '×',
    play: '▶',
    pause: '‖',
    settings: '⚙',
    tv: '📺',
    film: '🎬',
    folder: '📁',
    check: '✓',
    alert: '!',
    clock: '⏱'
  };
  return React.createElement('span', { 
    className: `inline-block ${className}`,
    style: { fontSize: size }
  }, icons[name] || '•');
}

function HLSDownloader() {
  const [urls, setUrls] = useState(['']);
  const [downloads, setDownloads] = useState([]);
  const [mediaType, setMediaType] = useState('tv');
  const [showName, setShowName] = useState('');
  const [movieName, setMovieName] = useState('');
  const [movieYear, setMovieYear] = useState('');
  const [seasonNumber, setSeasonNumber] = useState('');
  const [startEpisode, setStartEpisode] = useState('');
  const [endEpisode, setEndEpisode] = useState('');
  const [settings, setSettings] = useState({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    referer: '',
    cookie: '',
    retries: 3
  });
  const [showSettings, setShowSettings] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectStatus, setDetectStatus] = useState('');
  const [detectedStreams, setDetectedStreams] = useState([]);
  const wsRef = useRef(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsConnected(true);
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'detect-status') {
        setDetectStatus(data.message);
      } else if (data.type === 'progress') {
        setDownloads(prev => {
          const existing = prev.find(d => d.id === data.id);
          if (existing) {
            return prev.map(d => d.id === data.id ? { ...d, ...data } : d);
          } else {
            return [...prev, data];
          }
        });
      } else if (data.type === 'complete') {
        setIsProcessing(false);
      } else if (data.type === 'error') {
        console.error('Download error:', data.message);
        setIsProcessing(false);
      }
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setWsConnected(false);
    };
    
    wsRef.current = ws;
    
    return () => {
      ws.close();
    };
  }, []);

  const addUrlField = () => setUrls([...urls, '']);
  const removeUrlField = (index) => {
    if (urls.length > 1) setUrls(urls.filter((_, i) => i !== index));
  };
  const updateUrl = (index, value) => {
    const newUrls = [...urls];
    newUrls[index] = value;
    setUrls(newUrls);
  };

  const handleBulkPaste = (e) => {
    const pastedText = e.clipboardData.getData('text');
    const lines = pastedText.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    if (lines.length > 1) {
      e.preventDefault();
      setUrls(lines);
    }
  };

  const detectStream = async () => {
    if (!pageUrl.trim()) return;
    setIsDetecting(true);
    setDetectStatus('Starting...');
    setDetectedStreams([]);
    try {
      const response = await fetch('/api/detect-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageUrl: pageUrl.trim() })
      });
      const data = await response.json();
      if (!response.ok) {
        setDetectStatus('Error: ' + data.error);
        return;
      }
      setDetectedStreams(data.streams);
      setSettings(s => ({ ...s, cookie: data.cookie, referer: data.referer, userAgent: data.userAgent }));
      if (data.streams.length === 1) {
        setUrls([data.streams[0].url]);
        setDetectStatus('Stream detected and filled in below!');
      } else {
        setDetectStatus(`Found ${data.streams.length} streams — pick one below`);
      }
    } catch (err) {
      setDetectStatus('Error: ' + err.message);
    } finally {
      setIsDetecting(false);
    }
  };

  const startDownloads = async () => {
    const validUrls = urls.filter(u => u.trim());
    if (validUrls.length === 0) return;

    if (mediaType === 'tv') {
      if (!showName || !seasonNumber || !startEpisode) {
        alert('Please fill in show name, season number, and starting episode');
        return;
      }
    } else {
      if (!movieName || !movieYear) {
        alert('Please fill in movie name and year');
        return;
      }
    }

    setIsProcessing(true);
    setDownloads([]);

    const payload = {
      urls: validUrls,
      mediaType,
      settings,
      ...(mediaType === 'tv' ? {
        showName,
        seasonNumber: parseInt(seasonNumber),
        startEpisode: parseInt(startEpisode),
        endEpisode: endEpisode ? parseInt(endEpisode) : parseInt(startEpisode) + validUrls.length - 1
      } : {
        movieName,
        movieYear: parseInt(movieYear)
      })
    };

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error('Failed to start downloads');
    } catch (error) {
      console.error('Error:', error);
      alert('Failed to start downloads: ' + error.message);
      setIsProcessing(false);
    }
  };

  return React.createElement('div', { className: 'min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-6' },
    React.createElement('div', { className: 'max-w-6xl mx-auto' },
      
      // Header
      React.createElement('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20' },
        React.createElement('div', { className: 'flex items-center justify-between' },
          React.createElement('div', null,
            React.createElement('h1', { className: 'text-3xl font-bold text-white mb-2' },
              'Jellyfin HLS Downloader'
            ),
            React.createElement('p', { className: 'text-purple-200' },
              'Download and organize media for Jellyfin ',
              React.createElement('span', { 
                className: `inline-block w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`,
                title: wsConnected ? 'Connected' : 'Disconnected'
              })
            )
          ),
          React.createElement('button', {
            onClick: () => setShowSettings(!showSettings),
            className: 'p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-colors'
          }, '⚙️')
        )
      ),

      // Settings
      showSettings && React.createElement('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20' },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Advanced Settings'),
        React.createElement('div', { className: 'space-y-4' },
          React.createElement('div', null,
            React.createElement('label', { className: 'block text-purple-200 mb-2 text-sm' }, 'Max Retries'),
            React.createElement('input', {
              type: 'number',
              value: settings.retries,
              onChange: (e) => setSettings({...settings, retries: parseInt(e.target.value) || 3}),
              className: 'w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white',
              min: 1, max: 10
            })
          ),
          React.createElement('div', null,
            React.createElement('label', { className: 'block text-purple-200 mb-2 text-sm' }, 'Referer (optional)'),
            React.createElement('input', {
              type: 'text',
              value: settings.referer,
              onChange: (e) => setSettings({...settings, referer: e.target.value}),
              className: 'w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white',
              placeholder: 'https://example.com'
            })
          ),
          React.createElement('div', null,
            React.createElement('label', { className: 'block text-purple-200 mb-2 text-sm' }, 'Cookie (optional)'),
            React.createElement('input', {
              type: 'text',
              value: settings.cookie,
              onChange: (e) => setSettings({...settings, cookie: e.target.value}),
              className: 'w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white',
              placeholder: 'session=abc123'
            })
          )
        )
      ),

      // Media Type
      React.createElement('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20' },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Media Information'),
        React.createElement('div', { className: 'flex gap-4 mb-6' },
          React.createElement('button', {
            onClick: () => setMediaType('tv'),
            className: `flex-1 px-6 py-4 rounded-lg transition-all ${
              mediaType === 'tv' ? 'bg-purple-500 text-white' : 'bg-white/10 text-purple-200'
            }`
          }, '📺 TV Show'),
          React.createElement('button', {
            onClick: () => setMediaType('movie'),
            className: `flex-1 px-6 py-4 rounded-lg transition-all ${
              mediaType === 'movie' ? 'bg-purple-500 text-white' : 'bg-white/10 text-purple-200'
            }`
          }, '🎬 Movie')
        ),

        mediaType === 'tv' ? 
          React.createElement('div', { className: 'space-y-4' },
            React.createElement('input', {
              type: 'text',
              value: showName,
              onChange: (e) => setShowName(e.target.value),
              placeholder: 'Show Name (e.g., Game of Thrones)',
              className: 'w-full bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300'
            }),
            React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
              React.createElement('input', {
                type: 'number',
                value: seasonNumber,
                onChange: (e) => setSeasonNumber(e.target.value),
                placeholder: 'Season #',
                className: 'bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300',
                min: 1
              }),
              React.createElement('input', {
                type: 'number',
                value: startEpisode,
                onChange: (e) => setStartEpisode(e.target.value),
                placeholder: 'Starting Episode',
                className: 'bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300',
                min: 1
              })
            ),
            showName && seasonNumber && React.createElement('div', { className: 'bg-blue-500/10 rounded-lg p-3 border border-blue-500/20' },
              React.createElement('p', { className: 'text-blue-200 text-sm' },
                `📁 /mnt/nas/shows/${showName}/Season ${String(seasonNumber).padStart(2, '0')}/`
              )
            )
          ) :
          React.createElement('div', { className: 'space-y-4' },
            React.createElement('input', {
              type: 'text',
              value: movieName,
              onChange: (e) => setMovieName(e.target.value),
              placeholder: 'Movie Name',
              className: 'w-full bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300'
            }),
            React.createElement('input', {
              type: 'number',
              value: movieYear,
              onChange: (e) => setMovieYear(e.target.value),
              placeholder: 'Year',
              className: 'w-full bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300',
              min: 1800, max: 2100
            }),
            movieName && movieYear && React.createElement('div', { className: 'bg-blue-500/10 rounded-lg p-3 border border-blue-500/20' },
              React.createElement('p', { className: 'text-blue-200 text-sm' },
                `📁 /mnt/nas/movies/${movieName} (${movieYear})/`
              )
            )
          )
      ),

      // Auto-detect
      React.createElement('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20' },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, '🔍 Auto-Detect Stream'),
        React.createElement('p', { className: 'text-purple-200 text-sm mb-3' },
          'Paste the webpage URL where the video is playing. The browser will open it, find the stream, and capture all required cookies automatically.'
        ),
        React.createElement('div', { className: 'flex gap-2 mb-3' },
          React.createElement('input', {
            type: 'text',
            value: pageUrl,
            onChange: e => setPageUrl(e.target.value),
            disabled: isDetecting,
            placeholder: 'https://example.com/watch/episode-1',
            className: 'flex-1 bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300 disabled:opacity-50'
          }),
          React.createElement('button', {
            onClick: detectStream,
            disabled: isDetecting || !pageUrl.trim(),
            className: 'px-6 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white font-semibold rounded-lg whitespace-nowrap'
          }, isDetecting ? '⏳ Detecting...' : '🔍 Detect')
        ),
        detectStatus && React.createElement('p', { className: 'text-purple-200 text-sm mb-3' }, detectStatus),
        detectedStreams.length > 0 && React.createElement('div', { className: 'space-y-2' },
          detectedStreams.length > 1 && React.createElement('p', { className: 'text-purple-200 text-sm' }, 'Pick a stream to use:'),
          detectedStreams.map((s, i) => {
            // Build a readable label from the URL
            let label = s.url;
            try {
              const u = new URL(s.url);
              // For proxy URLs, extract the inner filename
              const innerUrl = u.searchParams.get('url');
              if (innerUrl) {
                const inner = new URL(decodeURIComponent(innerUrl));
                label = inner.pathname.split('/').pop().split('?')[0] || inner.hostname;
              } else {
                label = (u.hostname + u.pathname).replace(/^www\./, '');
                if (label.length > 60) label = label.substring(0, 60) + '…';
              }
            } catch {}
            const qualityBadge = s.quality || s.resolution;
            return React.createElement('button', {
              key: i,
              onClick: () => { setUrls([s.url]); setDetectStatus(`Selected ${s.type.toUpperCase()} stream`); },
              className: 'flex items-center gap-2 w-full text-left px-3 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-xs text-purple-200'
            },
              React.createElement('span', {
                className: `px-1.5 py-0.5 rounded text-white font-bold shrink-0 ${s.type === 'm3u8' ? 'bg-blue-500' : s.type === 'dash' ? 'bg-green-500' : 'bg-orange-500'}`
              }, s.type.toUpperCase()),
              qualityBadge && React.createElement('span', {
                className: 'px-1.5 py-0.5 rounded bg-white/20 text-white font-bold shrink-0'
              }, qualityBadge),
              s.size && React.createElement('span', { className: 'shrink-0 text-purple-300' }, s.size),
              s.bitrate && React.createElement('span', { className: 'shrink-0 text-purple-400' }, s.bitrate),
              React.createElement('span', { className: 'font-mono text-purple-300 truncate' }, label)
            );
          })
        )
      ),

      // URLs
      React.createElement('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20' },
        React.createElement('div', { className: 'flex items-center justify-between mb-4' },
          React.createElement('h2', { className: 'text-xl font-bold text-white' }, 'URLs'),
          React.createElement('button', {
            onClick: addUrlField,
            disabled: isProcessing,
            className: 'px-4 py-2 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg'
          }, '+ Add URL')
        ),
        React.createElement('div', { className: 'space-y-3' },
          urls.map((url, i) =>
            React.createElement('div', { key: i, className: 'flex gap-2' },
              React.createElement('input', {
                type: 'text',
                value: url,
                onChange: (e) => updateUrl(i, e.target.value),
                onPaste: i === 0 ? handleBulkPaste : undefined,
                disabled: isProcessing,
                placeholder: `URL #${i + 1} (paste multiple in first field)`,
                className: 'flex-1 bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-purple-300 disabled:opacity-50'
              }),
              urls.length > 1 && React.createElement('button', {
                onClick: () => removeUrlField(i),
                disabled: isProcessing,
                className: 'px-4 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg'
              }, '×')
            )
          )
        ),
        React.createElement('button', {
          onClick: startDownloads,
          disabled: isProcessing || !wsConnected || urls.every(u => !u.trim()),
          className: 'w-full mt-4 px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:opacity-50 text-white font-semibold rounded-lg'
        }, isProcessing ? '⏸ Processing...' : '▶ Start Downloads')
      ),

      // Progress
      downloads.length > 0 && React.createElement('div', { className: 'bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20' },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Progress'),
        React.createElement('div', { className: 'space-y-3' },
          downloads.map(d =>
            React.createElement('div', { key: d.id, className: 'bg-white/5 rounded-lg p-4' },
              React.createElement('div', { className: 'flex justify-between mb-2' },
                React.createElement('span', { className: 'text-white font-medium' }, d.filename),
                React.createElement('span', { className: 'text-purple-300 text-sm' },
                  d.status === 'completed' ? '✓' :
                  d.status === 'failed' ? '✗' : '⏱'
                )
              ),
              d.progress !== undefined && React.createElement('div', null,
                React.createElement('div', { className: 'h-2 bg-white/10 rounded-full overflow-hidden mb-1' },
                  React.createElement('div', {
                    className: 'h-full bg-gradient-to-r from-purple-500 to-pink-500',
                    style: { width: `${d.progress}%` }
                  })
                ),
                React.createElement('div', { className: 'flex justify-between text-xs text-purple-200' },
                  React.createElement('span', null, `${d.progress.toFixed(1)}%`),
                  d.speed && React.createElement('span', null, d.speed),
                  d.eta && React.createElement('span', null, `ETA: ${d.eta}`)
                )
              )
            )
          )
        )
      )
    )
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(HLSDownloader));
