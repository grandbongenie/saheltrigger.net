(function () {
  'use strict';

  const ENDPOINTS = {
    whepCandidates: [
      '/livefeed/whep/live/saheltrigger_webrtc',
      '/whep/live/saheltrigger_webrtc',
      '/livefeed/whep/live/saheltrigger',
      '/whep/live/saheltrigger'
    ],
    hlsCandidates: ['/livefeed/hls/live/saheltrigger/index.m3u8', '/hls/live/saheltrigger/index.m3u8'],
    captionsWs: '/captions/ws',
    replay: '/replay/latest.mp4',
    captions: {
      fr: '/captions/fr.vtt',
      en: '/captions/en.vtt',
      es: '/captions/es.vtt'
    },
    liveState: '/data/live_state.json',
    publicCatalog: '/archives/public_index.json',
    privateCatalog: '/archives/private_index.json'
  };

  const player = document.getElementById('mainPlayer');
  const statusEl = document.getElementById('streamStatus');
  const subtitleEl = document.getElementById('subtitleLang');
  const archivesListEl = document.getElementById('archivesList');
  const accessMessageEl = document.getElementById('archiveAccessMessage');
  const unmuteBtn = document.getElementById('unmuteBtn');
  const AUDIO_OWNER_KEY = 'saheltrigger_live_audio_owner';
  const tabId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const remoteStream = new MediaStream();
  let hlsInstance = null;
  let webrtcPc = null;
  let liveCaptionsWs = null;
  let liveCaptionResetTimer = null;
  let liveCaptionTrack = null;
  let liveCaptionCue = null;
  let userRequestedUnmute = false;
  let audioOwnershipTimer = null;
  let currentSubtitles = {};
  let privateCatalogCache = [];

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setAccessMessage(html) {
    if (accessMessageEl) accessMessageEl.innerHTML = html || '';
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function showUnmute(show) {
    if (!unmuteBtn) return;
    unmuteBtn.style.display = show ? 'inline-block' : 'none';
  }

  function stopLiveStacks() {
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) {}
      hlsInstance = null;
    }
    if (webrtcPc) {
      try { webrtcPc.close(); } catch (e) {}
      webrtcPc = null;
    }
    if (liveCaptionsWs) {
      try { liveCaptionsWs.close(); } catch (e) {}
      liveCaptionsWs = null;
    }
    if (liveCaptionResetTimer) {
      clearTimeout(liveCaptionResetTimer);
      liveCaptionResetTimer = null;
    }
    if (liveCaptionTrack) {
      try {
        if (liveCaptionCue && liveCaptionTrack.removeCue) liveCaptionTrack.removeCue(liveCaptionCue);
      } catch (_e) {}
      liveCaptionCue = null;
      try { liveCaptionTrack.mode = 'disabled'; } catch (_e) {}
      liveCaptionTrack = null;
    }
    try {
      remoteStream.getTracks().forEach((t) => {
        remoteStream.removeTrack(t);
        try { t.stop(); } catch (_e) {}
      });
    } catch (_e) {}
  }

  function hardResetPlayerSource() {
    try { player.pause(); } catch (_e) {}
    try { player.srcObject = null; } catch (_e) {}
    try { player.removeAttribute('src'); } catch (_e) {}
    try { player.load(); } catch (_e) {}
  }

  function selectedCaptionLang() {
    const lang = subtitleEl ? String(subtitleEl.value || '').toLowerCase() : 'fr';
    return ['fr', 'en', 'es'].includes(lang) ? lang : 'fr';
  }

  function ensureLiveCaptionTrack() {
    if (liveCaptionTrack) return liveCaptionTrack;
    let track = null;
    try {
      track = player.addTextTrack('captions', 'LIVE', selectedCaptionLang());
      track.mode = 'showing';
    } catch (_e) {
      track = null;
    }
    liveCaptionTrack = track;
    return track;
  }

  function updateLiveCaptionTrack(text, finalFlag) {
    const track = ensureLiveCaptionTrack();
    if (!track || !text) return;
    const now = player.currentTime || 0;
    const end = now + (finalFlag ? 4.0 : 1.5);
    const CueCtor = window.VTTCue || window.TextTrackCue;
    if (!CueCtor) return;
    try {
      if (liveCaptionCue && track.removeCue) track.removeCue(liveCaptionCue);
    } catch (_e) {}
    try {
      liveCaptionCue = new CueCtor(now, end, text);
      track.addCue(liveCaptionCue);
      track.mode = 'showing';
    } catch (_e) {}
  }

  function renderLiveCaption(payload) {
    if (!payload) return;
    const translations = payload.translations || {};
    const lang = selectedCaptionLang();
    const text = translations[lang] || payload.text || '';
    updateLiveCaptionTrack(text, payload.final === true);
    if (liveCaptionResetTimer) clearTimeout(liveCaptionResetTimer);
    if (payload.final === true) {
      liveCaptionResetTimer = setTimeout(() => {
        if (liveCaptionTrack && liveCaptionCue) {
          try { liveCaptionTrack.removeCue(liveCaptionCue); } catch (_e) {}
          liveCaptionCue = null;
        }
      }, 5000);
    }
  }

  async function attemptUnmute() {
    userRequestedUnmute = true;
    const ownerRaw = localStorage.getItem(AUDIO_OWNER_KEY);
    const now = Date.now();
    if (ownerRaw) {
      try {
        const owner = JSON.parse(ownerRaw);
        if (owner && owner.id !== tabId && (now - Number(owner.ts || 0)) < 6000) {
          player.muted = true;
          setStatus('Audio active in another tab/device.');
          showUnmute(true);
          return;
        }
      } catch (_e) {}
    }
    localStorage.setItem(AUDIO_OWNER_KEY, JSON.stringify({ id: tabId, ts: now }));
    if (!player.muted) return;
    player.muted = false;
    player.volume = 1.0;
    try {
      await player.play();
      showUnmute(false);
    } catch (_e) {
      // Keep button visible when browser blocks automatic unmute.
      showUnmute(true);
    }
  }

  function startLiveCaptions() {
    if (liveCaptionsWs && (liveCaptionsWs.readyState === WebSocket.OPEN || liveCaptionsWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}${ENDPOINTS.captionsWs}`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = function (ev) {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      if (!msg || msg.type !== 'caption') return;
      renderLiveCaption(msg);
    };
    ws.onclose = function () {
      if (liveCaptionsWs === ws) liveCaptionsWs = null;
    };
    ws.onerror = function () {};
    liveCaptionsWs = ws;
  }

  function clearTracks() {
    const tracks = player.querySelectorAll('track[data-dynamic="1"]');
    tracks.forEach((t) => t.remove());
  }

  function enforceSelectedTrackMode() {
    const preferred = selectedCaptionLang();
    const tracks = player.textTracks || [];
    for (let i = 0; i < tracks.length; i += 1) {
      const tt = tracks[i];
      if (!tt) continue;
      tt.mode = (tt.language === preferred) ? 'showing' : 'disabled';
    }
  }

  function applySubtitles() {
    clearTracks();
    const preferred = subtitleEl ? subtitleEl.value : 'fr';
    ['fr', 'en', 'es'].forEach((lang) => {
      const url = currentSubtitles[lang];
      if (!url) return;
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = lang.toUpperCase();
      tr.srclang = lang;
      tr.src = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
      tr.default = (lang === preferred);
      tr.addEventListener('load', enforceSelectedTrackMode);
      tr.dataset.dynamic = '1';
      player.appendChild(tr);
    });
    // Run once after DOM insertion since default selection can be ignored by some browsers.
    setTimeout(enforceSelectedTrackMode, 0);
  }

  function replayUrlNoCache() {
    return `${ENDPOINTS.replay}${ENDPOINTS.replay.includes('?') ? '&' : '?'}v=${Date.now()}`;
  }

  function normalizeCatalog(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.archives)) return data.archives;
    return [];
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts || {});
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  async function loadPrivateCatalog() {
    const data = await fetchJson(ENDPOINTS.privateCatalog, { cache: 'no-store', credentials: 'include' });
    privateCatalogCache = normalizeCatalog(data);
    return privateCatalogCache;
  }

  async function loadPublicCatalog() {
    const data = await fetchJson(ENDPOINTS.publicCatalog, { cache: 'no-store' });
    return normalizeCatalog(data);
  }

  function findPrivateById(id) {
    return privateCatalogCache.find((x) => x && x.id === id) || null;
  }

  function findPrivateByObjectKey(videoKey) {
    if (!videoKey) return null;
    return privateCatalogCache.find((x) => x && x.object && x.object.video_key === videoKey) || null;
  }

  async function playSignedItem(item, label, subtitleOverride) {
    if (!item || !item.signedUrl) {
      throw new Error('signed item missing');
    }
    stopLiveStacks();
    hardResetPlayerSource();
    player.src = item.signedUrl;
    currentSubtitles = subtitleOverride || item.subtitleSignedUrls || {};
    applySubtitles();
    showUnmute(true);
    await player.play().catch(() => {});
    setStatus(label);
  }

  async function playReplayFallbackLocal() {
    return playReplayFallbackLocalWithSubtitles(null);
  }

  function replaySubtitlesFromState(state) {
    const replay = state && state.replay ? state.replay : null;
    const fromState = replay && replay.subtitles && typeof replay.subtitles === 'object' ? replay.subtitles : {};
    const subtitles = {
      fr: fromState.fr || '',
      en: fromState.en || '',
      es: fromState.es || ''
    };
    return subtitles;
  }

  function replayObjectSubsFromState(state) {
    const replay = state && state.replay ? state.replay : null;
    const fromObject = replay && replay.object && replay.object.subs && typeof replay.object.subs === 'object'
      ? replay.object.subs
      : {};
    return {
      fr: fromObject.fr || '',
      en: fromObject.en || '',
      es: fromObject.es || ''
    };
  }

  function hasAllSubtitleUrls(subs) {
    if (!subs || typeof subs !== 'object') return false;
    return ['fr', 'en', 'es'].every((lang) => Boolean(subs[lang]));
  }

  function mapSignedSubtitlesForObject(subtitleSignedUrls, objectSubs) {
    if (!subtitleSignedUrls || !objectSubs) return {};
    const mapped = {};
    ['fr', 'en', 'es'].forEach((lang) => {
      if (objectSubs[lang] && subtitleSignedUrls[lang]) mapped[lang] = subtitleSignedUrls[lang];
    });
    return mapped;
  }

  async function replayFallbackSubtitlesAvailable() {
    const checks = await Promise.all(['fr', 'en', 'es'].map(async (lang) => {
      const url = ENDPOINTS.captions[lang];
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
      return Boolean(res && res.ok);
    }));
    return checks.every(Boolean);
  }

  async function playReplayFallbackLocalWithSubtitles(subtitles) {
    stopLiveStacks();
    hardResetPlayerSource();
    player.src = replayUrlNoCache();
    currentSubtitles = subtitles || { fr: ENDPOINTS.captions.fr, en: ENDPOINTS.captions.en, es: ENDPOINTS.captions.es };
    applySubtitles();
    showUnmute(true);
    await player.play().catch(() => {});
    setStatus('Replay');
  }

  async function tryWebRTC(timeoutMs) {
    function waitIceGatheringComplete(peer) {
      if (peer.iceGatheringState === 'complete') return Promise.resolve();
      return new Promise((resolve) => {
        const onState = () => {
          if (peer.iceGatheringState === 'complete') {
            peer.removeEventListener('icegatheringstatechange', onState);
            resolve();
          }
        };
        peer.addEventListener('icegatheringstatechange', onState);
        setTimeout(resolve, 2000);
      });
    }

    function parseIceServersFromLink(linkRaw) {
      if (!linkRaw) return [];
      const out = [];
      const parts = String(linkRaw).split(/,\s*(?=<)/g);
      for (const p of parts) {
        if (!/rel=\"ice-server\"/.test(p)) continue;
        const mUrl = p.match(/<([^>]+)>/);
        if (!mUrl) continue;
        const ice = { urls: mUrl[1] };
        const mUser = p.match(/username=\"([^\"]*)\"/);
        const mCred = p.match(/credential=\"([^\"]*)\"/);
        if (mUser) ice.username = mUser[1];
        if (mCred) ice.credential = mCred[1];
        out.push(ice);
      }
      return out;
    }

    let iceServers = [];
    for (const whepUrl of ENDPOINTS.whepCandidates) {
      const opt = await fetch(whepUrl, { method: 'OPTIONS' }).catch(() => null);
      if (opt && opt.ok) {
        const parsed = parseIceServersFromLink(opt.headers.get('Link'));
        if (parsed.length > 0) {
          iceServers = parsed;
          break;
        }
      }
    }

    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: iceServers });
    let gotTrack = false;
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.ontrack = function (ev) {
        gotTrack = true;
        const incoming = ev.track;
        if (incoming) {
          // Keep exactly one track per kind to avoid duplicate audio (echo/reverb).
          remoteStream.getTracks().forEach((t) => {
            if (t.kind === incoming.kind && t.id !== incoming.id) {
              remoteStream.removeTrack(t);
              try { t.stop(); } catch (_e) {}
            }
          });
          const exists = remoteStream.getTracks().some((t) => t.id === incoming.id);
          if (!exists) remoteStream.addTrack(incoming);
        }
        player.srcObject = remoteStream;
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceGatheringComplete(pc);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp = null;
      for (const whepUrl of ENDPOINTS.whepCandidates) {
        resp = await fetch(whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp', 'Accept': 'application/sdp' },
          body: offer.sdp,
          signal: ctrl.signal,
          credentials: 'omit'
        }).catch(() => null);
        if (resp && resp.ok) break;
      }
      clearTimeout(timer);

      if (!resp || !resp.ok) {
        pc.close();
        return false;
      }

      const answerSdp = await resp.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WebRTC timeout')), timeoutMs);
        const i = setInterval(() => {
          if (gotTrack) {
            clearTimeout(t);
            clearInterval(i);
            resolve();
          }
        }, 150);
      });

      webrtcPc = pc;
      // Don't re-mute if user already interacted to unmute.
      player.muted = !userRequestedUnmute;
      player.volume = 1.0;
      showUnmute(true);
      await player.play().catch(() => {});
      if (userRequestedUnmute) {
        await attemptUnmute();
      }
      startLiveCaptions();
      return true;
    } catch (_e) {
      try { pc.close(); } catch (_err) {}
      return false;
    }
  }

  async function tryHls() {
    // Keep muted for autoplay reliability; user can unmute explicitly.
    player.muted = true;
    if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
      hlsInstance = new window.Hls({ lowLatencyMode: true, enableWorker: true });
      let chosen = ENDPOINTS.hlsCandidates[0];
      for (const hlsUrl of ENDPOINTS.hlsCandidates) {
        const head = await fetch(hlsUrl, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
        if (head && head.ok) {
          chosen = hlsUrl;
          break;
        }
      }
      hlsInstance.loadSource(chosen);
      hlsInstance.attachMedia(player);
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('HLS timeout')), 5000);
        hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
          clearTimeout(to);
          resolve();
        });
        hlsInstance.on(window.Hls.Events.ERROR, (_, data) => {
          if (data && data.fatal) {
            clearTimeout(to);
            reject(new Error('HLS fatal'));
          }
        });
      });
      showUnmute(true);
      await player.play().catch(() => {});
      return true;
    }

    if (player.canPlayType('application/vnd.apple.mpegurl')) {
      player.srcObject = null;
      player.src = ENDPOINTS.hlsCandidates[0];
      showUnmute(true);
      await player.play().catch(() => {});
      return true;
    }

    return false;
  }

  async function startLiveMode() {
    // Hard reset player graph to avoid any parallel audio path after retries/reloads.
    stopLiveStacks();
    hardResetPlayerSource();

    setStatus('Trying live (WebRTC)...');
    currentSubtitles = {};
    applySubtitles();

    const webRtcOk = await tryWebRTC(8000);
    if (webRtcOk) {
      setStatus('Live (WebRTC)');
      return true;
    }
    setStatus('WebRTC unavailable. Trying HLS...');
    const hlsOk = await tryHls();
    if (hlsOk) {
      setStatus('Live (HLS fallback)');
      return true;
    }
    setStatus('Live unavailable.');
    return false;
  }

  async function playArchive(id) {
    setAccessMessage('');
    let item = findPrivateById(id);
    if (!item) {
      try {
        await loadPrivateCatalog();
      } catch (_e) {}
      item = findPrivateById(id);
    }

    if (!item || !item.signedUrl) {
      const subject = encodeURIComponent(`Request access archive ${id}`);
      const mailto = `mailto:acces@saheltrigger.net?subject=${subject}`;
      setAccessMessage(`Request access to <a href="${mailto}">acces@saheltrigger.net</a>`);
      return;
    }

    await playSignedItem(item, `Archive: ${item.title || id}`);
  }

  function renderArchives(items) {
    if (!archivesListEl) return;
    archivesListEl.innerHTML = '';

    if (!Array.isArray(items) || items.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No archives listed yet.';
      archivesListEl.appendChild(li);
      return;
    }

    items.forEach((item) => {
      if (!item || !item.id) return;
      const li = document.createElement('li');
      li.style.marginBottom = '8px';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${item.title || item.id} | ${formatDate(item.dateISO)} | ${formatDuration(item.durationSeconds)}`;
      btn.addEventListener('click', () => playArchive(item.id));

      li.appendChild(btn);
      archivesListEl.appendChild(li);
    });
  }

  async function loadAndRenderArchives() {
    try {
      const publicItems = await loadPublicCatalog();
      renderArchives(publicItems);
    } catch (_e) {
      renderArchives([]);
    }
  }

  async function loadLiveState() {
    try {
      return await fetchJson(ENDPOINTS.liveState, { cache: 'no-store' });
    } catch (_e) {
      return { mode: 'OFFLINE', replay: null };
    }
  }

  async function playReplayFromState(state) {
    let item = null;
    let replayObjectSubs = replayObjectSubsFromState(state);
    if (state && state.replay) {
      try {
        await loadPrivateCatalog();
      } catch (_e) {}
      if (state.replay.session_id) {
        item = findPrivateById(state.replay.session_id);
      }
      if (!item && state.replay.object && state.replay.object.video_key) {
        item = findPrivateByObjectKey(state.replay.object.video_key);
      }
    }

    // Priority A: live_state replay.object.subs resolved through private_index signed URLs.
    if (item && item.signedUrl && hasAllSubtitleUrls(replayObjectSubs)) {
      const resolvedFromStateObject = mapSignedSubtitlesForObject(item.subtitleSignedUrls || {}, replayObjectSubs);
      if (hasAllSubtitleUrls(resolvedFromStateObject)) {
        stopLiveStacks();
        hardResetPlayerSource();
        player.src = item.signedUrl;
        currentSubtitles = resolvedFromStateObject;
        applySubtitles();
        showUnmute(true);
        await player.play().catch(() => {});
        setStatus('Replay');
        return true;
      }
    }

    // Priority B: private_index subtitleSignedUrls for the matching replay item.
    if (item && item.signedUrl && hasAllSubtitleUrls(item.subtitleSignedUrls || {})) {
      await playSignedItem(item, 'Replay');
      return true;
    }

    // Priority C: local fallback captions only as emergency fallback.
    let localFallbackSubtitles = replaySubtitlesFromState(state);
    if (!hasAllSubtitleUrls(localFallbackSubtitles)) {
      localFallbackSubtitles = { fr: ENDPOINTS.captions.fr, en: ENDPOINTS.captions.en, es: ENDPOINTS.captions.es };
    }
    const localFallbackReady = await replayFallbackSubtitlesAvailable();
    if (localFallbackReady) {
      try {
        const res = await fetch(replayUrlNoCache(), { method: 'HEAD', cache: 'no-store' });
        if (res && res.ok) {
          await playReplayFallbackLocalWithSubtitles(localFallbackSubtitles);
          return true;
        }
      } catch (_e) {}
    }
    return false;
  }

  async function boot() {
    const okLive = await startLiveMode();
    if (okLive) return;

    setStatus('Offline. Archives available below.');
    stopLiveStacks();
    player.pause();
    player.srcObject = null;
    player.removeAttribute('src');
    player.load();
    showUnmute(false);
  }

  if (subtitleEl) {
    subtitleEl.addEventListener('change', () => {
      applySubtitles();
      enforceSelectedTrackMode();
      if (liveCaptionTrack) {
        try { liveCaptionTrack.language = selectedCaptionLang(); } catch (_e) {}
        try { liveCaptionTrack.mode = 'showing'; } catch (_e) {}
      }
    });
  }

  if (unmuteBtn) {
    unmuteBtn.addEventListener('click', async () => {
      await attemptUnmute();
    });
  }

  function refreshAudioOwnership() {
    const now = Date.now();
    const ownerRaw = localStorage.getItem(AUDIO_OWNER_KEY);
    let owner = null;
    try { owner = ownerRaw ? JSON.parse(ownerRaw) : null; } catch (_e) {}
    const mine = owner && owner.id === tabId;
    const expired = !owner || (now - Number(owner.ts || 0)) >= 6000;

    if (!document.hidden && (mine || expired || player.muted === false)) {
      localStorage.setItem(AUDIO_OWNER_KEY, JSON.stringify({ id: tabId, ts: now }));
      return;
    }

    if (!mine && !expired) {
      player.muted = true;
      showUnmute(true);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      player.muted = true;
      showUnmute(true);
    } else {
      refreshAudioOwnership();
    }
  });
  window.addEventListener('storage', (ev) => {
    if (ev.key !== AUDIO_OWNER_KEY) return;
    refreshAudioOwnership();
  });
  audioOwnershipTimer = setInterval(refreshAudioOwnership, 2000);

  // First user gesture should unmute automatically.
  ['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, () => { attemptUnmute(); }, { once: true, passive: true });
  });
  player.addEventListener('dblclick', () => { attemptUnmute(); });
  document.addEventListener('fullscreenchange', () => { attemptUnmute(); });
  player.addEventListener('loadedmetadata', () => { enforceSelectedTrackMode(); });

  boot();
})();
