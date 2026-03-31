const { useState, useRef, useEffect } = React;

function HLSDownloader() {
  // Shared state
  const [downloadMode, setDownloadMode] = useState('manual'); // 'manual' | 'bulk'
  const [downloads, setDownloads] = useState([]);
  const [settings, setSettings] = useState({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    referer: '',
    cookie: '',
    retries: 3
  });
  const [showSettings, setShowSettings] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'purple');
  const wsRef = useRef(null);

  // Manual mode state
  const [urls, setUrls] = useState(['']);
  const [mediaType, setMediaType] = useState('tv');
  const [showName, setShowName] = useState('');
  const [movieName, setMovieName] = useState('');
  const [movieYear, setMovieYear] = useState('');
  const [seasonNumber, setSeasonNumber] = useState('');
  const [startEpisode, setStartEpisode] = useState('');
  const [endEpisode, setEndEpisode] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectStatus, setDetectStatus] = useState('');
  const [detectedStreams, setDetectedStreams] = useState([]);

  // Domain filter (shared)
  const [requiredDomain, setRequiredDomain] = useState('valhallastream');

  // Global source selection
  const [source, setSource] = useState('rivestream'); // 'rivestream' | 'custom'

  // Bulk mode state
  const [bulkBaseUrl, setBulkBaseUrl] = useState('');
  const [bulkShowName, setBulkShowName] = useState('');
  const [bulkQuality, setBulkQuality] = useState('best');
  const [bulkSeasons, setBulkSeasons] = useState([{ season: 1, startEpisode: 1, endEpisode: 10 }]);
  const [bulkRetries, setBulkRetries] = useState(3);
  const [bulkRequiredDomain, setBulkRequiredDomain] = useState('');
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkProgress, setBulkProgress] = useState(null); // { current, total }
  const [showInfo, setShowInfo] = useState(null); // { seasons, showName } from auto-detect
  const [isDetectingShow, setIsDetectingShow] = useState(false);
  const [detectShowStatus, setDetectShowStatus] = useState('');

  // Follow mode state
  const [followedShows, setFollowedShows] = useState([]);
  const [followUrl, setFollowUrl] = useState('');
  const [followName, setFollowName] = useState('');
  const [followQuality, setFollowQuality] = useState('best');
  const [followInterval, setFollowInterval] = useState(6);
  const [followDownloadExisting, setFollowDownloadExisting] = useState(false);
  const [followDetectedInfo, setFollowDetectedInfo] = useState(null);
  const [isDetectingFollow, setIsDetectingFollow] = useState(false);
  const [detectFollowStatus, setDetectFollowStatus] = useState('');
  const [isAddingFollow, setIsAddingFollow] = useState(false);

  useEffect(() => {
    let reconnectTimeout;
    let reconnectDelay = 1000;
    let shouldReconnect = true;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        reconnectDelay = 1000;
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
          setIsProcessing(false);
        } else if (data.type === 'bulk-status') {
          setBulkStatus(data.message);
          if (data.current && data.total) {
            setBulkProgress({ current: data.current, total: data.total });
          }
        } else if (data.type === 'bulk-complete') {
          setIsBulkProcessing(false);
          setBulkStatus(data.message);
          setBulkProgress(null);
        } else if (data.type === 'session-state') {
          if (data.isProcessing) setIsProcessing(true);
          if (data.isBulkProcessing) {
            setIsBulkProcessing(true);
            if (data.bulkStatus) setBulkStatus(data.bulkStatus);
            if (data.bulkProgress) setBulkProgress(data.bulkProgress);
          }
        } else if (data.type === 'followed-shows') {
          setFollowedShows(data.shows);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        wsRef.current = null;
        if (shouldReconnect) {
          reconnectTimeout = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            connect();
          }, reconnectDelay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      shouldReconnect = false;
      clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Manual mode handlers
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

    // When Rivestream source is selected, auto-fill media info from the URL before detecting the stream
    if (source === 'rivestream') {
      try {
        setDetectStatus('Looking up media info...');
        const infoRes = await fetch('/api/show-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: pageUrl.trim() }),
        });
        const info = await infoRes.json();
        if (infoRes.ok) {
          if (info.mediaType === 'movie') {
            setMediaType('movie');
            if (info.movieName) setMovieName(info.movieName);
            if (info.movieYear) setMovieYear(String(info.movieYear));
          } else {
            setMediaType('tv');
            if (info.showName) setShowName(info.showName);
            if (info.season) setSeasonNumber(String(info.season));
            if (info.episode) setStartEpisode(String(info.episode));
          }
        }
      } catch {}
    }

    try {
      setDetectStatus('Detecting stream...');
      const domainFilter = source === 'rivestream' ? 'valhallastream' : (requiredDomain.trim() || undefined);
      const response = await fetch('/api/detect-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageUrl: pageUrl.trim(), requiredDomain: domainFilter })
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
      alert('Failed to start downloads: ' + error.message);
      setIsProcessing(false);
    }
  };

  // Bulk mode handlers
  const addBulkSeason = () => {
    const last = bulkSeasons[bulkSeasons.length - 1];
    setBulkSeasons([...bulkSeasons, { season: (parseInt(last.season) || 1) + 1, startEpisode: 1, endEpisode: 10 }]);
  };

  const removeBulkSeason = (index) => {
    if (bulkSeasons.length > 1) setBulkSeasons(bulkSeasons.filter((_, i) => i !== index));
  };

  const updateBulkSeason = (index, field, value) => {
    // Allow empty string so users can fully clear the field before typing a new number
    const stored = value === '' ? '' : (parseInt(value) || 1);
    const updated = bulkSeasons.map((s, i) => i === index ? { ...s, [field]: stored } : s);
    setBulkSeasons(updated);
  };

  const startBulkDownload = async () => {
    if (!bulkBaseUrl.trim() || !bulkShowName.trim()) {
      alert('Please fill in the show URL and show name');
      return;
    }

    setIsBulkProcessing(true);
    setBulkStatus('Starting...');
    setBulkProgress(null);
    setDownloads([]);

    try {
      const response = await fetch('/api/bulk-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: bulkBaseUrl.trim(),
          seasons: bulkSeasons.map(s => ({
            season: parseInt(s.season) || 1,
            startEpisode: parseInt(s.startEpisode) || 1,
            endEpisode: parseInt(s.endEpisode) || 1,
          })),
          quality: bulkQuality,
          showName: bulkShowName.trim(),
          retries: source === 'rivestream' ? 5 : bulkRetries,
          requiredDomain: source === 'rivestream' ? 'valhallastream' : (bulkRequiredDomain.trim() || undefined),
        })
      });
      const data = await response.json();
      if (!response.ok) {
        alert('Error: ' + data.error);
        setIsBulkProcessing(false);
      }
    } catch (err) {
      alert('Failed to start bulk download: ' + err.message);
      setIsBulkProcessing(false);
    }
  };

  const detectShow = async () => {
    if (!bulkBaseUrl.trim()) return;
    setIsDetectingShow(true);
    setDetectShowStatus('Opening page and scanning for season data...');
    setShowInfo(null);
    try {
      const response = await fetch('/api/show-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: bulkBaseUrl.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setDetectShowStatus('Could not detect: ' + data.error);
        return;
      }
      setShowInfo(data);
      if (data.showName && !bulkShowName.trim()) setBulkShowName(data.showName);
      setBulkSeasons(data.seasons);
      const totalEp = data.seasons.reduce((sum, s) => sum + s.endEpisode, 0);
      setDetectShowStatus(`Detected ${data.seasons.length} season${data.seasons.length !== 1 ? 's' : ''}, ${totalEp} episodes`);
    } catch (err) {
      setDetectShowStatus('Error: ' + err.message);
    } finally {
      setIsDetectingShow(false);
    }
  };

  const detectFollowShow = async () => {
    if (!followUrl.trim()) return;
    setIsDetectingFollow(true);
    setDetectFollowStatus('Looking up show...');
    setFollowDetectedInfo(null);
    try {
      const response = await fetch('/api/show-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: followUrl.trim() }),
      });
      const data = await response.json();
      if (!response.ok) { setDetectFollowStatus('Could not detect: ' + data.error); return; }
      setFollowDetectedInfo(data);
      if (data.showName && !followName.trim()) setFollowName(data.showName);
      const totalEp = data.seasons.reduce((sum, s) => sum + s.endEpisode, 0);
      setDetectFollowStatus(`${data.showName} — ${data.seasons.length} season${data.seasons.length !== 1 ? 's' : ''}, ${totalEp} episodes`);
    } catch (err) {
      setDetectFollowStatus('Error: ' + err.message);
    } finally {
      setIsDetectingFollow(false);
    }
  };

  const addFollowShow = async () => {
    if (!followUrl.trim()) return;
    setIsAddingFollow(true);
    try {
      const response = await fetch('/api/followed-shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: followUrl.trim(),
          name: followName.trim() || undefined,
          quality: followQuality,
          checkIntervalHours: followInterval,
          downloadExisting: followDownloadExisting,
        }),
      });
      const data = await response.json();
      if (!response.ok) { alert(data.error); return; }
      setFollowUrl(''); setFollowName(''); setFollowDetectedInfo(null); setDetectFollowStatus('');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setIsAddingFollow(false);
    }
  };

  const removeFollowShow = async (id) => {
    await fetch(`/api/followed-shows/${id}`, { method: 'DELETE' });
  };

  const checkFollowShowNow = async (id) => {
    await fetch(`/api/followed-shows/${id}/check`, { method: 'POST' });
  };

  const formatRelativeTime = (isoString) => {
    if (!isoString) return 'never';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const isDark = theme === 'dark';
  const toggleTheme = () => {
    const next = isDark ? 'purple' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
  };

  // Theme-aware classes
  const inputClass = isDark
    ? 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500'
    : 'w-full bg-white/[0.13] border border-white/25 rounded-lg px-4 py-3 text-white placeholder-purple-300';
  const cardClass = isDark
    ? 'bg-gray-900 rounded-2xl p-5 mb-4 border border-gray-800'
    : 'bg-white/[0.13] backdrop-blur-lg rounded-2xl p-5 mb-4 border border-white/20';
  const subCard = isDark
    ? 'bg-gray-800/70 rounded-xl border border-gray-700/60'
    : 'bg-white/5 rounded-xl border border-white/10';
  const mutedText = isDark ? 'text-gray-400' : 'text-purple-300';
  const dimText = isDark ? 'text-gray-500' : 'text-purple-400';
  const rowBg = isDark ? 'bg-gray-800/50' : 'bg-white/5';
  const outerBg = isDark
    ? 'min-h-screen bg-gray-950 p-3'
    : 'min-h-screen bg-gradient-to-br from-slate-800 via-purple-800 to-slate-800 p-3';

  // Per-season progress derived from the downloads list (filenames encode S01E02)
  const getSeasonStats = (seasonNum, startEp, endEp) => {
    const total = Math.max(0, (parseInt(endEp) || 0) - (parseInt(startEp) || 0) + 1);
    const eps = downloads.filter(d => {
      const m = d.filename?.match(/S(\d{2})E/i);
      return m && parseInt(m[1]) === parseInt(seasonNum);
    });
    const done = eps.filter(d => d.status === 'completed').length;
    const failed = eps.filter(d => d.status === 'failed').length;
    const active = eps.find(d => d.status === 'downloading' || d.status === 'starting');
    const allDone = total > 0 && eps.length > 0 && done + failed >= total;
    return { total, done, failed, active, allDone };
  };

  return React.createElement('div', { className: outerBg },
    React.createElement('div', { className: 'max-w-6xl mx-auto' },

      // Header
      React.createElement('div', { className: cardClass },
        React.createElement('div', { className: 'flex items-center justify-between' },
          React.createElement('div', null,
            React.createElement('h1', { className: 'text-3xl font-bold text-white mb-2' }, 'Jellyfin HLS Downloader'),
            React.createElement('p', { className: mutedText },
              'Download and organize media for Jellyfin ',
              React.createElement('span', {
                className: `inline-block w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`,
                title: wsConnected ? 'Connected' : 'Disconnected'
              })
            )
          ),
          React.createElement('div', { className: 'flex gap-2' },
            React.createElement('button', {
              onClick: toggleTheme,
              title: isDark ? 'Switch to Purple theme' : 'Switch to Dark theme',
              className: isDark
                ? 'p-3 bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors text-gray-300'
                : 'p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-colors'
            }, isDark ? '🌙' : '☀️'),
            React.createElement('button', {
              onClick: () => setShowSettings(!showSettings),
              className: isDark
                ? 'p-3 bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors text-gray-300'
                : 'p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-colors'
            }, '⚙️')
          )
        )
      ),

      // Settings
      showSettings && React.createElement('div', { className: cardClass },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Advanced Settings'),
        React.createElement('div', { className: 'space-y-4' },
          React.createElement('div', null,
            React.createElement('label', { className: `block mb-2 text-sm ${mutedText}` }, 'Max Retries'),
            React.createElement('input', {
              type: 'number',
              value: settings.retries,
              onChange: (e) => setSettings({ ...settings, retries: parseInt(e.target.value) || 3 }),
              className: inputClass,
              min: 1, max: 10
            })
          ),
          React.createElement('div', null,
            React.createElement('label', { className: `block mb-2 text-sm ${mutedText}` }, 'Referer (optional)'),
            React.createElement('input', {
              type: 'text',
              value: settings.referer,
              onChange: (e) => setSettings({ ...settings, referer: e.target.value }),
              className: inputClass,
              placeholder: 'https://example.com'
            })
          ),
          React.createElement('div', null,
            React.createElement('label', { className: `block mb-2 text-sm ${mutedText}` }, 'Cookie (optional)'),
            React.createElement('input', {
              type: 'text',
              value: settings.cookie,
              onChange: (e) => setSettings({ ...settings, cookie: e.target.value }),
              className: inputClass,
              placeholder: 'session=abc123'
            })
          )
        )
      ),

      // Source + Mode Toggle
      React.createElement('div', { className: cardClass },
        // Source selection
        React.createElement('div', { className: 'flex gap-2 mb-3' },
          React.createElement('button', {
            onClick: () => setSource('rivestream'),
            className: `flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${source === 'rivestream' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-300 hover:bg-white/20')}`
          }, '🎬 Rivestream'),
          React.createElement('button', {
            onClick: () => { setSource('custom'); if (downloadMode === 'follow') setDownloadMode('manual'); },
            className: `flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${source === 'custom' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-300 hover:bg-white/20')}`
          }, '⚙️ Custom Source')
        ),
        React.createElement('div', { className: `border-t mb-3 ${isDark ? 'border-gray-700' : 'border-white/10'}` }),
        // Mode tabs
        React.createElement('div', { className: 'flex gap-3' },
          React.createElement('button', {
            onClick: () => setDownloadMode('manual'),
            className: `flex-1 py-3 rounded-xl font-semibold transition-all ${downloadMode === 'manual' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-200 hover:bg-white/20')}`
          }, '🔗 Manual'),
          React.createElement('button', {
            onClick: () => setDownloadMode('bulk'),
            className: `flex-1 py-3 rounded-xl font-semibold transition-all ${downloadMode === 'bulk' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-200 hover:bg-white/20')}`
          }, '📦 Bulk'),
          source === 'rivestream' && React.createElement('button', {
            onClick: () => setDownloadMode('follow'),
            className: `flex-1 py-3 rounded-xl font-semibold transition-all ${downloadMode === 'follow' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-200 hover:bg-white/20')}`
          }, `📺 Follow${followedShows.length > 0 ? ` (${followedShows.length})` : ''}`)
        )
      ),

      // ── MANUAL MODE ──
      downloadMode === 'manual' && React.createElement(React.Fragment, null,

        // Media Information
        React.createElement('div', { className: cardClass },
          React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Media Information'),
          React.createElement('div', { className: 'flex gap-4 mb-6' },
            React.createElement('button', {
              onClick: () => setMediaType('tv'),
              className: `flex-1 px-6 py-4 rounded-lg transition-all ${mediaType === 'tv' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-200')}`
            }, '📺 TV Show'),
            React.createElement('button', {
              onClick: () => setMediaType('movie'),
              className: `flex-1 px-6 py-4 rounded-lg transition-all ${mediaType === 'movie' ? 'bg-purple-500 text-white' : (isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white/10 text-purple-200')}`
            }, '🎬 Movie')
          ),

          mediaType === 'tv' ?
            React.createElement('div', { className: 'space-y-4' },
              React.createElement('input', {
                type: 'text', value: showName,
                onChange: (e) => setShowName(e.target.value),
                placeholder: 'Show Name (e.g., Game of Thrones)',
                className: inputClass
              }),
              React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
                React.createElement('input', {
                  type: 'number', value: seasonNumber,
                  onChange: (e) => setSeasonNumber(e.target.value),
                  placeholder: 'Season #', className: inputClass, min: 1
                }),
                React.createElement('input', {
                  type: 'number', value: startEpisode,
                  onChange: (e) => setStartEpisode(e.target.value),
                  placeholder: 'Starting Episode', className: inputClass, min: 1
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
                type: 'text', value: movieName,
                onChange: (e) => setMovieName(e.target.value),
                placeholder: 'Movie Name', className: inputClass
              }),
              React.createElement('input', {
                type: 'number', value: movieYear,
                onChange: (e) => setMovieYear(e.target.value),
                placeholder: 'Year', className: inputClass, min: 1800, max: 2100
              }),
              movieName && movieYear && React.createElement('div', { className: 'bg-blue-500/10 rounded-lg p-3 border border-blue-500/20' },
                React.createElement('p', { className: 'text-blue-200 text-sm' },
                  `📁 /mnt/nas/movies/${movieName} (${movieYear})/`
                )
              )
            )
        ),

        // Auto-Detect
        React.createElement('div', { className: cardClass },
          React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, '🔍 Auto-Detect Stream'),
          React.createElement('p', { className: `${mutedText} text-sm mb-3` },
            source === 'rivestream'
              ? 'Paste a Rivestream URL. Show/movie name, season and episode will be filled in automatically, and the stream will be detected.'
              : 'Paste the webpage URL where the video is playing. The browser will open it, find the stream, and capture all required cookies automatically.'
          ),
          React.createElement('div', { className: 'flex gap-2 mb-2' },
            React.createElement('input', {
              type: 'text', value: pageUrl,
              onChange: e => setPageUrl(e.target.value),
              disabled: isDetecting,
              placeholder: source === 'rivestream'
                ? 'https://rivestream.org/watch?type=tv&id=79744&season=1&episode=1'
                : 'https://example.com/watch/episode-1',
              className: `flex-1 disabled:opacity-50 ${inputClass}`
            }),
            React.createElement('button', {
              onClick: detectStream,
              disabled: isDetecting || !pageUrl.trim(),
              className: 'px-6 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white font-semibold rounded-lg whitespace-nowrap'
            }, isDetecting ? '⏳ Detecting...' : '🔍 Detect')
          ),
          source === 'rivestream'
            ? React.createElement('div', { className: 'flex items-center gap-2 mb-3' },
                React.createElement('span', { className: 'text-xs bg-green-500/20 text-green-300 border border-green-500/30 rounded px-2 py-1' },
                  '✓ Domain: valhallastream'
                )
              )
            : React.createElement('div', { className: 'flex items-center gap-2 mb-3' },
                React.createElement('label', { className: `${mutedText} text-xs whitespace-nowrap` }, 'Required domain:'),
                React.createElement('input', {
                  type: 'text', value: requiredDomain,
                  onChange: e => setRequiredDomain(e.target.value),
                  disabled: isDetecting,
                  placeholder: 'e.g. valhallastream (leave empty to accept any)',
                  className: `flex-1 text-sm disabled:opacity-50 ${inputClass}`
                })
              ),
          detectStatus && React.createElement('p', { className: `${mutedText} text-sm mb-3` }, detectStatus),
          detectedStreams.length > 0 && React.createElement('div', { className: 'space-y-2' },
            detectedStreams.length > 1 && React.createElement('p', { className: `${mutedText} text-sm` }, 'Pick a stream to use:'),
            detectedStreams.map((s, i) => {
              let label = s.url;
              try {
                const u = new URL(s.url);
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
                className: `flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg text-xs ${mutedText} ${isDark ? 'bg-gray-800/50 hover:bg-gray-800' : 'bg-white/5 hover:bg-white/10'}`
              },
                React.createElement('span', {
                  className: `px-1.5 py-0.5 rounded text-white font-bold shrink-0 ${s.type === 'm3u8' ? 'bg-blue-500' : s.type === 'dash' ? 'bg-green-500' : 'bg-orange-500'}`
                }, s.type.toUpperCase()),
                qualityBadge && React.createElement('span', { className: 'px-1.5 py-0.5 rounded bg-white/20 text-white font-bold shrink-0' }, qualityBadge),
                s.size && React.createElement('span', { className: `shrink-0 ${mutedText}` }, s.size),
                s.bitrate && React.createElement('span', { className: `shrink-0 ${dimText}` }, s.bitrate),
                React.createElement('span', { className: `font-mono ${mutedText} truncate` }, label)
              );
            })
          )
        ),

        // URLs
        React.createElement('div', { className: cardClass },
          React.createElement('div', { className: 'flex items-center justify-between mb-4' },
            React.createElement('h2', { className: 'text-xl font-bold text-white' }, 'URLs'),
            React.createElement('button', {
              onClick: addUrlField, disabled: isProcessing,
              className: 'px-4 py-2 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg'
            }, '+ Add URL')
          ),
          React.createElement('div', { className: 'space-y-3' },
            urls.map((url, i) =>
              React.createElement('div', { key: i, className: 'flex gap-2' },
                React.createElement('input', {
                  type: 'text', value: url,
                  onChange: (e) => updateUrl(i, e.target.value),
                  onPaste: i === 0 ? handleBulkPaste : undefined,
                  disabled: isProcessing,
                  placeholder: `URL #${i + 1} (paste multiple in first field)`,
                  className: `flex-1 disabled:opacity-50 ${inputClass}`
                }),
                urls.length > 1 && React.createElement('button', {
                  onClick: () => removeUrlField(i), disabled: isProcessing,
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
        )
      ),

      // ── BULK MODE ──
      downloadMode === 'bulk' && React.createElement('div', { className: cardClass },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-5' }, '📦 Bulk Season Download'),

        // Source info / custom config
        React.createElement('div', { className: 'mb-5' },
          source === 'rivestream'
            ? React.createElement('div', { className: 'flex items-center gap-2 flex-wrap' },
                React.createElement('span', { className: 'text-xs bg-green-500/20 text-green-300 border border-green-500/30 rounded px-2 py-1' },
                  '✓ Domain: valhallastream'
                ),
                React.createElement('span', { className: 'text-xs bg-green-500/20 text-green-300 border border-green-500/30 rounded px-2 py-1' },
                  '✓ 5 retries per episode'
                ),
                React.createElement('span', { className: `${dimText} text-xs` }, 'Optimised for Rivestream — change source above to customise')
              )
            : React.createElement('div', { className: `space-y-3 rounded-xl p-4 ${subCard}` },
                React.createElement('p', { className: `${mutedText} text-xs` },
                  'Configure how streams are detected. Change source to Rivestream above for optimised defaults.'
                ),
                React.createElement('div', null,
                  React.createElement('label', { className: `block mb-1 text-xs font-medium ${mutedText}` }, 'Required stream domain'),
                  React.createElement('input', {
                    type: 'text',
                    value: bulkRequiredDomain,
                    onChange: e => setBulkRequiredDomain(e.target.value),
                    disabled: isBulkProcessing,
                    placeholder: 'e.g. valhallastream — leave empty to accept any CDN',
                    className: `w-full text-sm disabled:opacity-50 ${inputClass}`
                  }),
                  React.createElement('p', { className: `${dimText} text-xs mt-1` },
                    'When set, detection retries until a stream URL from this hostname is found (up to 5 attempts per episode).'
                  )
                ),
                React.createElement('div', null,
                  React.createElement('label', { className: `block mb-1 text-xs font-medium ${mutedText}` }, 'Retries per episode'),
                  React.createElement('input', {
                    type: 'number',
                    value: bulkRetries,
                    onChange: e => setBulkRetries(parseInt(e.target.value) || 3),
                    disabled: isBulkProcessing,
                    className: `w-32 text-sm disabled:opacity-50 ${inputClass}`,
                    min: 1, max: 10
                  }),
                  React.createElement('p', { className: `${dimText} text-xs mt-1` },
                    'How many times to retry stream detection and download per episode before giving up.'
                  )
                )
              )
        ),

        // ── Show URL + Detect button ──
        React.createElement('div', { className: 'space-y-4 mb-5' },
          React.createElement('div', null,
            React.createElement('label', { className: `block mb-2 text-sm ${mutedText}` },
              source === 'rivestream' ? 'Rivestream Show URL' : 'Show Page URL'
            ),
            React.createElement('div', { className: 'flex gap-2' },
              React.createElement('input', {
                type: 'text',
                value: bulkBaseUrl,
                onChange: e => setBulkBaseUrl(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter' && bulkBaseUrl.trim() && !isDetectingShow) detectShow(); },
                disabled: isBulkProcessing || isDetectingShow,
                placeholder: source === 'rivestream'
                  ? 'https://rivestream.org/watch?type=tv&id=79744'
                  : 'https://example.com/show/game-of-thrones',
                className: `flex-1 disabled:opacity-50 ${inputClass}`
              }),
              React.createElement('button', {
                onClick: detectShow,
                disabled: isBulkProcessing || isDetectingShow || !bulkBaseUrl.trim(),
                className: 'px-4 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white font-semibold rounded-lg whitespace-nowrap text-sm'
              }, isDetectingShow ? '⏳ Detecting...' : '🔍 Detect Show')
            ),
            detectShowStatus && React.createElement('p', {
              className: `text-sm mt-2 ${showInfo ? 'text-green-300' : mutedText}`
            }, detectShowStatus)
          ),

          // Auto-detect result: quick-select buttons
          showInfo && React.createElement('div', { className: 'bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4' },
            React.createElement('p', { className: 'text-indigo-200 text-sm font-medium mb-3' },
              `✓ Detected ${showInfo.seasons.length} season${showInfo.seasons.length !== 1 ? 's' : ''}`
            ),
            React.createElement('div', { className: 'flex flex-wrap gap-2' },
              // "Entire show" button
              React.createElement('button', {
                onClick: () => setBulkSeasons(showInfo.seasons),
                disabled: isBulkProcessing,
                className: 'px-3 py-1.5 bg-indigo-500/40 hover:bg-indigo-500/60 text-indigo-100 text-xs font-semibold rounded-lg disabled:opacity-50'
              }, `▶ Entire show (${showInfo.seasons.reduce((sum, s) => sum + s.endEpisode, 0)} ep)`),
              // Per-season buttons
              showInfo.seasons.map(s =>
                React.createElement('button', {
                  key: s.season,
                  onClick: () => setBulkSeasons([s]),
                  disabled: isBulkProcessing,
                  className: `px-3 py-1.5 text-xs rounded-lg disabled:opacity-50 ${mutedText} ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white/10 hover:bg-white/20'}`
                }, `S${String(s.season).padStart(2, '0')} (${s.endEpisode} ep)`)
              )
            )
          ),

          // Show Name
          React.createElement('div', null,
            React.createElement('label', { className: `block mb-2 text-sm ${mutedText}` }, 'Show Name (for Jellyfin)'),
            React.createElement('input', {
              type: 'text',
              value: bulkShowName,
              onChange: e => setBulkShowName(e.target.value),
              disabled: isBulkProcessing,
              placeholder: 'e.g., Game of Thrones',
              className: inputClass + ' disabled:opacity-50'
            })
          ),

          // Quality
          React.createElement('div', null,
            React.createElement('label', { className: `block mb-2 text-sm ${mutedText}` }, 'Quality'),
            React.createElement('select', {
              value: bulkQuality,
              onChange: e => setBulkQuality(e.target.value),
              disabled: isBulkProcessing,
              className: `w-full disabled:opacity-50 ${inputClass}`
            },
              React.createElement('option', { value: 'best' }, 'Best available'),
              React.createElement('option', { value: '1080p' }, '1080p'),
              React.createElement('option', { value: '720p' }, '720p'),
              React.createElement('option', { value: '480p' }, '480p'),
              React.createElement('option', { value: '360p' }, '360p')
            )
          )
        ),

        // ── Season rows ──
        React.createElement('div', { className: 'mb-4' },
          React.createElement('div', { className: 'flex items-center justify-between mb-3' },
            React.createElement('label', { className: `text-sm font-medium ${mutedText}` }, 'Seasons & Episodes'),
            React.createElement('button', {
              onClick: addBulkSeason,
              disabled: isBulkProcessing,
              className: 'px-3 py-1.5 bg-purple-500/30 hover:bg-purple-500/50 text-purple-200 text-sm rounded-lg disabled:opacity-50'
            }, '+ Add Season')
          ),
          React.createElement('div', { className: 'space-y-2' },
            bulkSeasons.map((s, i) => {
              const stats = getSeasonStats(s.season, s.startEpisode, s.endEpisode);
              const epCount = Math.max(0, (parseInt(s.endEpisode) || 0) - (parseInt(s.startEpisode) || 0) + 1);
              const hasActivity = stats.done > 0 || stats.active || stats.failed > 0;
              const rowColor = stats.allDone
                ? (isDark ? 'bg-green-900/30 border border-green-800/50' : 'bg-green-500/10 border border-green-500/30')
                : rowBg;

              return React.createElement('div', { key: i, className: `rounded-lg px-4 py-3 ${rowColor}` },

                // Top row: inputs (hidden while processing) or completion badge
                stats.allDone
                  ? React.createElement('div', { className: 'flex items-center gap-3' },
                      React.createElement('span', { className: 'text-green-400 text-lg' }, '✓'),
                      React.createElement('span', { className: 'text-green-300 font-medium text-sm' },
                        `Season ${s.season}`
                      ),
                      React.createElement('span', { className: 'text-green-400/70 text-xs ml-1' },
                        `${stats.done}/${stats.total} downloaded${stats.failed > 0 ? `, ${stats.failed} failed` : ''}`
                      )
                    )
                  : React.createElement('div', { className: 'flex items-center gap-3' },
                      React.createElement('span', { className: `${mutedText} text-sm w-14 shrink-0` }, 'Season'),
                      React.createElement('input', {
                        type: 'number', value: s.season,
                        onChange: e => updateBulkSeason(i, 'season', e.target.value),
                        disabled: isBulkProcessing,
                        className: `w-14 rounded px-2 py-1.5 text-white text-sm ${isDark ? 'bg-gray-700 border border-gray-600' : 'bg-white/10 border border-white/20'}`, min: 1
                      }),
                      React.createElement('span', { className: `${mutedText} text-sm shrink-0` }, 'ep'),
                      React.createElement('input', {
                        type: 'number', value: s.startEpisode,
                        onChange: e => updateBulkSeason(i, 'startEpisode', e.target.value),
                        disabled: isBulkProcessing,
                        className: `w-14 rounded px-2 py-1.5 text-white text-sm ${isDark ? 'bg-gray-700 border border-gray-600' : 'bg-white/10 border border-white/20'}`, min: 1
                      }),
                      React.createElement('span', { className: `${mutedText} text-sm shrink-0` }, '–'),
                      React.createElement('input', {
                        type: 'number', value: s.endEpisode,
                        onChange: e => updateBulkSeason(i, 'endEpisode', e.target.value),
                        disabled: isBulkProcessing,
                        className: `w-14 rounded px-2 py-1.5 text-white text-sm ${isDark ? 'bg-gray-700 border border-gray-600' : 'bg-white/10 border border-white/20'}`, min: 1
                      }),
                      hasActivity
                        ? React.createElement('span', { className: `${mutedText} text-xs ml-auto shrink-0` },
                            `${stats.done}/${epCount}${stats.failed > 0 ? ` · ${stats.failed} ✗` : ''}`
                          )
                        : React.createElement('span', { className: `${dimText} text-xs ml-auto shrink-0` },
                            `${epCount} ep`
                          ),
                      !isBulkProcessing && bulkSeasons.length > 1 && React.createElement('button', {
                        onClick: () => removeBulkSeason(i),
                        className: 'text-red-400 hover:text-red-300 text-lg leading-none'
                      }, '×')
                    ),

                // Progress bar row — shown when this season has an active or partially complete episode
                hasActivity && !stats.allDone && React.createElement('div', { className: 'mt-2' },
                  // Overall season progress bar
                  React.createElement('div', { className: `h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-gray-700' : 'bg-white/10'}` },
                    React.createElement('div', {
                      className: 'h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300',
                      style: { width: `${epCount > 0 ? ((stats.done / epCount) * 100) : 0}%` }
                    })
                  ),
                  // Active episode detail
                  stats.active && React.createElement('div', { className: 'mt-1.5' },
                    React.createElement('div', { className: 'flex items-center justify-between mb-0.5' },
                      React.createElement('span', { className: `text-xs ${dimText}` },
                        stats.active.filename?.replace(/\.mp4$/i, '') || 'downloading...'
                      ),
                      React.createElement('span', { className: `text-xs ${dimText}` },
                        `${(stats.active.progress || 0).toFixed(0)}%`
                        + (stats.active.speed ? `  ${stats.active.speed}` : '')
                        + (stats.active.eta ? `  ETA ${stats.active.eta}` : '')
                      )
                    ),
                    React.createElement('div', { className: `h-1 rounded-full overflow-hidden ${isDark ? 'bg-gray-700' : 'bg-white/10'}` },
                      React.createElement('div', {
                        className: 'h-full bg-indigo-400 transition-all duration-300',
                        style: { width: `${stats.active.progress || 0}%` }
                      })
                    )
                  )
                )
              );
            })
          )
        ),

        // ── Summary ──
        React.createElement('div', { className: isDark ? 'bg-blue-900/20 rounded-lg p-3 border border-blue-800/40 mb-4' : 'bg-blue-500/10 rounded-lg p-3 border border-blue-500/20 mb-4' },
          React.createElement('p', { className: 'text-blue-200 text-sm' },
            `📁 /mnt/nas/shows/${bulkShowName || '…'}/  ·  `,
            `${bulkSeasons.reduce((sum, s) => sum + Math.max(0, (parseInt(s.endEpisode) || 0) - (parseInt(s.startEpisode) || 0) + 1), 0)} episodes total  ·  `,
            `Quality: ${bulkQuality === 'best' ? 'best available' : bulkQuality}  ·  `,
            source === 'rivestream'
              ? 'valhallastream · 5 retries'
              : `${bulkRequiredDomain.trim() || 'any domain'} · ${bulkRetries} retries`
          )
        ),

        // ── Progress ──
        isBulkProcessing && bulkProgress && React.createElement('div', { className: 'mb-4' },
          React.createElement('div', { className: `flex justify-between text-sm mb-1 ${mutedText}` },
            React.createElement('span', null, bulkStatus),
            React.createElement('span', null, `${bulkProgress.current}/${bulkProgress.total}`)
          ),
          React.createElement('div', { className: `h-2 rounded-full overflow-hidden ${isDark ? 'bg-gray-700' : 'bg-white/10'}` },
            React.createElement('div', {
              className: 'h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all',
              style: { width: `${(bulkProgress.current / bulkProgress.total) * 100}%` }
            })
          )
        ),
        (isBulkProcessing || bulkStatus) && !bulkProgress && React.createElement('p', { className: `text-sm mb-4 ${mutedText}` }, bulkStatus),

        // ── Start button ──
        React.createElement('button', {
          onClick: startBulkDownload,
          disabled: isBulkProcessing || !wsConnected || !bulkBaseUrl.trim() || !bulkShowName.trim(),
          className: 'w-full px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:opacity-50 text-white font-semibold rounded-lg'
        }, isBulkProcessing ? '⏸ Downloading...' : '▶ Start Bulk Download')
      ),

      // ── FOLLOW MODE ──
      downloadMode === 'follow' && React.createElement('div', null,

        // Add show card
        React.createElement('div', { className: cardClass },
          React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, '📺 Follow a Show'),
          React.createElement('p', { className: `text-sm mb-4 ${mutedText}` },
            'Add a Rivestream show URL. The app will check regularly and automatically download new episodes as they appear.'
          ),

          // URL row
          React.createElement('div', { className: 'flex gap-2 mb-3' },
            React.createElement('input', {
              type: 'text',
              value: followUrl,
              onChange: e => { setFollowUrl(e.target.value); setFollowDetectedInfo(null); setDetectFollowStatus(''); },
              onKeyDown: e => { if (e.key === 'Enter' && followUrl.trim() && !isDetectingFollow) detectFollowShow(); },
              disabled: isAddingFollow,
              placeholder: 'https://rivestream.org/watch?type=tv&id=79744',
              className: `flex-1 disabled:opacity-50 ${inputClass}`
            }),
            React.createElement('button', {
              onClick: detectFollowShow,
              disabled: isDetectingFollow || isAddingFollow || !followUrl.trim(),
              className: 'px-4 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white font-semibold rounded-lg whitespace-nowrap text-sm'
            }, isDetectingFollow ? '⏳' : '🔍 Detect')
          ),

          detectFollowStatus && React.createElement('p', {
            className: `text-sm mb-3 ${followDetectedInfo ? 'text-green-300' : mutedText}`
          }, detectFollowStatus),

          // Name override
          React.createElement('input', {
            type: 'text',
            value: followName,
            onChange: e => setFollowName(e.target.value),
            disabled: isAddingFollow,
            placeholder: 'Show name (auto-filled from detection)',
            className: `mb-3 disabled:opacity-50 ${inputClass}`
          }),

          // Quality + Interval row
          React.createElement('div', { className: 'flex gap-3 mb-3' },
            React.createElement('div', { className: 'flex-1' },
              React.createElement('label', { className: `block text-xs mb-1 ${mutedText}` }, 'Quality'),
              React.createElement('select', {
                value: followQuality,
                onChange: e => setFollowQuality(e.target.value),
                disabled: isAddingFollow,
                className: `w-full disabled:opacity-50 ${inputClass}`
              },
                React.createElement('option', { value: 'best' }, 'Best'),
                React.createElement('option', { value: '1080p' }, '1080p'),
                React.createElement('option', { value: '720p' }, '720p'),
                React.createElement('option', { value: '480p' }, '480p')
              )
            ),
            React.createElement('div', { className: 'flex-1' },
              React.createElement('label', { className: `block text-xs mb-1 ${mutedText}` }, 'Check every'),
              React.createElement('select', {
                value: followInterval,
                onChange: e => setFollowInterval(parseInt(e.target.value)),
                disabled: isAddingFollow,
                className: `w-full disabled:opacity-50 ${inputClass}`
              },
                React.createElement('option', { value: 1 }, '1 hour'),
                React.createElement('option', { value: 3 }, '3 hours'),
                React.createElement('option', { value: 6 }, '6 hours'),
                React.createElement('option', { value: 12 }, '12 hours'),
                React.createElement('option', { value: 24 }, '24 hours')
              )
            )
          ),

          // Download existing checkbox
          React.createElement('label', { className: `flex items-center gap-2 mb-4 cursor-pointer ${mutedText} text-sm` },
            React.createElement('input', {
              type: 'checkbox',
              checked: followDownloadExisting,
              onChange: e => setFollowDownloadExisting(e.target.checked),
              disabled: isAddingFollow,
              className: 'w-4 h-4 accent-purple-500'
            }),
            'Also download all existing episodes now'
          ),

          React.createElement('button', {
            onClick: addFollowShow,
            disabled: isAddingFollow || !followUrl.trim(),
            className: 'w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:opacity-50 text-white font-semibold rounded-lg'
          }, isAddingFollow ? '⏳ Adding...' : '+ Follow Show')
        ),

        // Followed shows list
        followedShows.length > 0 && React.createElement('div', { className: cardClass },
          React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Followed Shows'),
          React.createElement('div', { className: 'space-y-3' },
            followedShows.map(show => {
              const status = show.status;
              const isChecking = status?.checking;
              return React.createElement('div', {
                key: show.id,
                className: `rounded-xl p-4 ${isDark ? 'bg-gray-800/60 border border-gray-700/50' : 'bg-white/8 border border-white/15'}`
              },
                // Title row
                React.createElement('div', { className: 'flex items-start justify-between gap-3 mb-2' },
                  React.createElement('div', { className: 'min-w-0' },
                    React.createElement('p', { className: 'text-white font-semibold truncate' }, show.name),
                    React.createElement('p', { className: `text-xs ${dimText} mt-0.5` },
                      `${show.totalSeasons} season${show.totalSeasons !== 1 ? 's' : ''}  ·  ${show.totalEpisodes} episodes  ·  ${show.quality === 'best' ? 'best quality' : show.quality}  ·  checks every ${show.checkIntervalHours}h`
                    )
                  ),
                  React.createElement('div', { className: 'flex gap-1.5 shrink-0' },
                    React.createElement('button', {
                      onClick: () => checkFollowShowNow(show.id),
                      disabled: isChecking,
                      title: 'Check now',
                      className: `px-2.5 py-1.5 text-xs rounded-lg disabled:opacity-40 transition-colors ${isDark ? 'bg-gray-700 hover:bg-gray-600 text-gray-300' : 'bg-white/10 hover:bg-white/20 text-purple-200'}`
                    }, isChecking ? '⏳' : '🔄'),
                    React.createElement('button', {
                      onClick: () => { if (confirm(`Unfollow "${show.name}"?`)) removeFollowShow(show.id); },
                      title: 'Unfollow',
                      className: `px-2.5 py-1.5 text-xs rounded-lg transition-colors ${isDark ? 'bg-gray-700 hover:bg-red-900/50 text-gray-400 hover:text-red-400' : 'bg-white/10 hover:bg-red-500/20 text-purple-300 hover:text-red-300'}`
                    }, '✕')
                  )
                ),

                // Status + last checked
                React.createElement('div', { className: 'flex items-center justify-between' },
                  React.createElement('p', {
                    className: `text-xs ${isChecking ? 'text-indigo-400' : (status?.message?.includes('failed') ? 'text-red-400' : (status?.message?.includes('Downloaded') || status?.message?.includes('new ep') ? 'text-green-400' : dimText))}`
                  }, status?.message || 'Waiting for first check'),
                  React.createElement('p', { className: `text-xs ${dimText}` },
                    show.lastChecked ? `Checked ${formatRelativeTime(show.lastChecked)}` : 'Not yet checked'
                  )
                )
              );
            })
          )
        ),

        followedShows.length === 0 && React.createElement('div', { className: `${cardClass} text-center py-8` },
          React.createElement('p', { className: `${mutedText} text-sm` }, 'No shows followed yet. Add one above.')
        )
      ),

      // Progress (shared)
      downloads.length > 0 && React.createElement('div', { className: cardClass },
        React.createElement('h2', { className: 'text-xl font-bold text-white mb-4' }, 'Progress'),
        React.createElement('div', { className: 'space-y-3' },
          downloads.map(d =>
            React.createElement('div', { key: d.id, className: `${isDark ? 'bg-gray-800/60 rounded-lg p-4' : 'bg-white/5 rounded-lg p-4'}` },
              React.createElement('div', { className: 'flex justify-between mb-2' },
                React.createElement('span', { className: 'text-white font-medium' }, d.filename),
                React.createElement('span', { className: `${mutedText} text-sm` },
                  d.status === 'completed' ? '✓' :
                  d.status === 'failed' ? '✗' : '⏱'
                )
              ),
              d.progress !== undefined && React.createElement('div', null,
                React.createElement('div', { className: `h-2 rounded-full overflow-hidden mb-1 ${isDark ? 'bg-gray-700' : 'bg-white/10'}` },
                  React.createElement('div', {
                    className: 'h-full bg-gradient-to-r from-purple-500 to-pink-500',
                    style: { width: `${d.progress}%` }
                  })
                ),
                React.createElement('div', { className: `flex justify-between text-xs ${mutedText}` },
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
