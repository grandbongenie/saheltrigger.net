'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const { WebSocketServer, WebSocket } = require('ws');

const envPath = process.env.CAPTIONS_ENV_FILE || '/etc/saheltrigger/captions.env';
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config({ path: path.join(__dirname, '.env') });
}

const CFG = {
  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiRealtimeUrl: process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime?intent=transcription',
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  transcriptionLanguage: process.env.OPENAI_TRANSCRIPTION_LANGUAGE || 'auto',
  translationModel: process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini',
  sampleRate: Number(process.env.AUDIO_SAMPLE_RATE || 24000),
  ffmpegInputUrl: process.env.FFMPEG_INPUT_URL || 'rtmp://127.0.0.1:8443/live/saheltrigger',
  captionsHost: process.env.CAPTIONS_HOST || '127.0.0.1',
  captionsPort: Number(process.env.CAPTIONS_PORT || 3010),
  broadcastPartials: String(process.env.BROADCAST_PARTIALS || 'true').toLowerCase() === 'true',
  translatePartials: String(process.env.TRANSLATE_PARTIALS || 'true').toLowerCase() === 'true',
  partialTranslateThrottleMs: Number(process.env.PARTIAL_TRANSLATE_THROTTLE_MS || 900),
  partialTranslateMinChars: Number(process.env.PARTIAL_TRANSLATE_MIN_CHARS || 14),
  finalLeadMs: Number(process.env.CAPTION_FINAL_LEAD_MS || 900),
  finalTailMs: Number(process.env.CAPTION_FINAL_TAIL_MS || 2500),
  partialLeadMs: Number(process.env.CAPTION_PARTIAL_LEAD_MS || 250),
  partialTailMs: Number(process.env.CAPTION_PARTIAL_TAIL_MS || 1200),
  reconnectMs: Number(process.env.OPENAI_RECONNECT_MS || 1500),
  ffmpegRestartMs: Number(process.env.FFMPEG_RESTART_MS || 1000),
  maxPendingChunks: Number(process.env.MAX_PENDING_CHUNKS || 80)
};

if (!CFG.openAiApiKey) {
  console.error('[captions] OPENAI_API_KEY is missing. Set it in environment or /etc/saheltrigger/captions.env');
  process.exit(1);
}

let browserClients = new Set();
let openAiWs = null;
let ffmpegProc = null;
let openAiReady = false;
let reconnectTimer = null;
let ffmpegRestartTimer = null;
let sessionAttempt = 0;
let currentLanguage = (CFG.transcriptionLanguage || 'auto').toLowerCase();
const seenEventTypes = new Set();

const partialByItemId = new Map();
const partialTranslateState = new Map();
const pendingAudioChunks = [];
let captionSeq = 0;
const recentCaptionKeys = new Map();
const DUP_WINDOW_MS = 1800;

function nowMs() {
  return Date.now();
}

function captionId() {
  return `cap_${nowMs()}_${captionSeq++}`;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function emitCaption(text, isFinal, translations) {
  const cleaned = (text || '').trim();
  if (!cleaned) return;

  const t = translations || { fr: cleaned, en: cleaned, es: cleaned };
  const dedupeKey = [
    isFinal ? 'F' : 'P',
    cleaned.toLowerCase(),
    String(t.fr || '').toLowerCase(),
    String(t.en || '').toLowerCase(),
    String(t.es || '').toLowerCase()
  ].join('|');
  const nowDedup = Date.now();
  const lastSeen = recentCaptionKeys.get(dedupeKey) || 0;
  if (nowDedup - lastSeen < DUP_WINDOW_MS) {
    return;
  }
  recentCaptionKeys.set(dedupeKey, nowDedup);
  if (recentCaptionKeys.size > 500) {
    for (const [k, ts] of recentCaptionKeys) {
      if (nowDedup - ts > 10000) recentCaptionKeys.delete(k);
    }
  }

  const now = nowMs();
  const lead = isFinal ? CFG.finalLeadMs : CFG.partialLeadMs;
  const tail = isFinal ? CFG.finalTailMs : CFG.partialTailMs;

  broadcast({
    type: 'caption',
    id: captionId(),
    t0: now - lead,
    t1: now + tail,
    text: cleaned,
    translations: t,
    final: Boolean(isFinal)
  });
  console.log(`[captions] ${isFinal ? 'final' : 'partial'}: ${cleaned}`);
}

function buildSessionPayloadNew() {
  const transcription = { model: CFG.transcriptionModel };
  if (['fr', 'en', 'es'].includes(currentLanguage)) {
    transcription.language = currentLanguage;
  }

  return {
    type: 'transcription_session.update',
    session: {
      input_audio_format: 'pcm16',
      input_audio_transcription: transcription,
      turn_detection: {
        type: 'server_vad',
        threshold: 0.45,
        prefix_padding_ms: 120,
        silence_duration_ms: 120
      },
      input_audio_noise_reduction: {
        type: 'near_field'
      }
    }
  };
}

function buildSessionPayloadLegacy() {
  return buildSessionPayloadNew();
}

function sendSessionUpdate() {
  if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
  const payload = sessionAttempt === 0 ? buildSessionPayloadNew() : buildSessionPayloadLegacy();
  openAiWs.send(JSON.stringify(payload));
}

async function handleOpenAiEvent(event) {
  if (!event || typeof event.type !== 'string') return;

  if (
    event.type === 'transcription_session.created' ||
    event.type === 'transcription_session.updated' ||
    event.type === 'session.created' ||
    event.type === 'session.updated'
  ) {
    openAiReady = true;
    const sessionLang =
      event.session &&
      event.session.input_audio_transcription &&
      event.session.input_audio_transcription.language;
    if (typeof sessionLang === 'string' && sessionLang.trim()) {
      currentLanguage = sessionLang.trim().toLowerCase();
    }
    return;
  }

  if (event.type === 'error') {
    const msg = event.error && event.error.message ? event.error.message : JSON.stringify(event);
    console.error('[captions] OpenAI error event:', msg);

    if (!openAiReady && sessionAttempt === 0) {
      sessionAttempt = 1;
      sendSessionUpdate();
      return;
    }
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    const itemId = event.item_id || event.id;
    const delta = event.delta || '';
    if (!itemId || !delta) return;

    const nextText = `${partialByItemId.get(itemId) || ''}${delta}`;
    partialByItemId.set(itemId, nextText);

    if (CFG.broadcastPartials && !CFG.translatePartials) {
      emitCaption(nextText, false, { fr: nextText, en: nextText, es: nextText });
    }
    if (CFG.translatePartials && itemId) maybeEmitTranslatedPartial(itemId, nextText);
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = event.item_id || event.id;
    const text =
      event.transcript ||
      (event.content && event.content[0] && (event.content[0].transcript || event.content[0].text)) ||
      (itemId ? partialByItemId.get(itemId) : '') ||
      '';
    if (itemId) partialByItemId.delete(itemId);
    if (itemId) partialTranslateState.delete(itemId);
    await emitFinalCaption(text);
    return;
  }

  if (event.type === 'response.audio_transcript.delta') {
    const itemId = event.item_id || event.response_id || 'response';
    const nextText = `${partialByItemId.get(itemId) || ''}${event.delta || ''}`;
    partialByItemId.set(itemId, nextText);
    if (CFG.broadcastPartials && !CFG.translatePartials) {
      emitCaption(nextText, false, { fr: nextText, en: nextText, es: nextText });
    }
    if (CFG.translatePartials && itemId) maybeEmitTranslatedPartial(itemId, nextText);
    return;
  }

  if (event.type === 'response.audio_transcript.done') {
    const itemId = event.item_id || event.response_id || 'response';
    const text = event.transcript || partialByItemId.get(itemId) || '';
    partialByItemId.delete(itemId);
    partialTranslateState.delete(itemId);
    await emitFinalCaption(text);
    return;
  }

  if (!seenEventTypes.has(event.type)) {
    seenEventTypes.add(event.type);
    console.log(`[captions] OpenAI event: ${event.type}`);
  }
}

function maybeEmitTranslatedPartial(itemId, text) {
  const cleaned = (text || '').trim();
  if (!cleaned || cleaned.length < CFG.partialTranslateMinChars) return;

  const state = partialTranslateState.get(itemId) || { inFlight: false, lastAt: 0, lastText: '' };
  const now = Date.now();
  if (state.inFlight) return;
  if (state.lastText === cleaned) return;
  if (now - state.lastAt < CFG.partialTranslateThrottleMs) return;

  state.inFlight = true;
  state.lastAt = now;
  state.lastText = cleaned;
  partialTranslateState.set(itemId, state);

  translateAllLanguages(cleaned)
    .then((translations) => {
      emitCaption(cleaned, false, translations);
    })
    .catch(() => {
      // keep raw partial only
    })
    .finally(() => {
      const latest = partialTranslateState.get(itemId);
      if (latest) latest.inFlight = false;
    });
}

async function translateAllLanguages(text) {
  const src = (text || '').trim();
  if (!src) return { fr: '', en: '', es: '' };

  const body = {
    model: CFG.translationModel,
    input: [
      {
        role: 'system',
        content: 'Translate the subtitle into French, English and Spanish. Return strict JSON with keys fr,en,es only.'
      },
      {
        role: 'user',
        content: src
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'subtitle_translations',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fr: { type: 'string' },
            en: { type: 'string' },
            es: { type: 'string' }
          },
          required: ['fr', 'en', 'es']
        }
      }
    }
  };

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.openAiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`translation http ${resp.status}`);

  const data = await resp.json();
  let raw = data.output_text || '';
  if (!raw && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item || !Array.isArray(item.content)) continue;
      const textPart = item.content.find((c) => c && c.type === 'output_text' && typeof c.text === 'string');
      if (textPart && textPart.text) {
        raw = textPart.text;
        break;
      }
    }
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed.fr !== 'string' || typeof parsed.en !== 'string' || typeof parsed.es !== 'string') {
    throw new Error('translation parse error');
  }

  return {
    fr: parsed.fr.trim() || src,
    en: parsed.en.trim() || src,
    es: parsed.es.trim() || src
  };
}

async function emitFinalCaption(text) {
  const cleaned = (text || '').trim();
  if (!cleaned) return;
  try {
    const translations = await translateAllLanguages(cleaned);
    emitCaption(cleaned, true, translations);
  } catch (err) {
    console.error('[captions] translation error:', err.message);
    emitCaption(cleaned, true, { fr: cleaned, en: cleaned, es: cleaned });
  }
}

function flushAudioQueue() {
  if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
  while (pendingAudioChunks.length) {
    const chunk = pendingAudioChunks.shift();
    openAiWs.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64')
      })
    );
  }
}

function enqueueAudioChunk(chunk) {
  if (!chunk || chunk.length === 0) return;

  if (pendingAudioChunks.length >= CFG.maxPendingChunks) {
    pendingAudioChunks.shift();
  }
  pendingAudioChunks.push(chunk);
  flushAudioQueue();
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleOpenAiReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(connectOpenAi, CFG.reconnectMs);
}

function connectOpenAi() {
  clearReconnectTimer();

  openAiReady = false;
  sessionAttempt = 0;

  const ws = new WebSocket(CFG.openAiRealtimeUrl, {
    headers: {
      Authorization: `Bearer ${CFG.openAiApiKey}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openAiWs = ws;

  ws.on('open', () => {
    console.log('[captions] Connected to OpenAI Realtime.');
    sendSessionUpdate();
    flushAudioQueue();
  });

  ws.on('message', async (raw) => {
    const event = safeJsonParse(raw.toString());
    if (!event) return;
    try {
      await handleOpenAiEvent(event);
    } catch (err) {
      console.error('[captions] handle event error:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.error(`[captions] OpenAI WS closed: ${code} ${reason || ''}`);
    openAiReady = false;
    if (openAiWs === ws) {
      openAiWs = null;
    }
    scheduleOpenAiReconnect();
  });

  ws.on('error', (err) => {
    console.error('[captions] OpenAI WS error:', err.message);
  });
}

function clearFfmpegRestartTimer() {
  if (ffmpegRestartTimer) {
    clearTimeout(ffmpegRestartTimer);
    ffmpegRestartTimer = null;
  }
}

function scheduleFfmpegRestart() {
  clearFfmpegRestartTimer();
  ffmpegRestartTimer = setTimeout(startFfmpeg, CFG.ffmpegRestartMs);
}

function startFfmpeg() {
  clearFfmpegRestartTimer();

  if (ffmpegProc) {
    try {
      ffmpegProc.kill('SIGTERM');
    } catch (_err) {
      // ignored
    }
    ffmpegProc = null;
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    CFG.ffmpegInputUrl,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(CFG.sampleRate),
    '-f',
    's16le',
    'pipe:1'
  ];

  console.log('[captions] Starting ffmpeg:', ['ffmpeg', ...args].join(' '));
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  ffmpegProc = child;

  child.stdout.on('data', (chunk) => {
    enqueueAudioChunk(chunk);
  });

  child.stderr.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.error('[captions][ffmpeg]', line);
  });

  child.on('close', (code, signal) => {
    console.error(`[captions] ffmpeg exited (code=${code}, signal=${signal || ''}). Restarting...`);
    if (ffmpegProc === child) ffmpegProc = null;
    scheduleFfmpegRestart();
  });

  child.on('error', (err) => {
    console.error('[captions] ffmpeg spawn error:', err.message);
    if (ffmpegProc === child) ffmpegProc = null;
    scheduleFfmpegRestart();
  });
}

function createCaptionServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('saheltrigger captions ws service\n');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket) => {
    browserClients.add(socket);

    socket.send(
      JSON.stringify({
        type: 'hello',
        ts: nowMs(),
        model: CFG.transcriptionModel,
        language: currentLanguage,
        targets: ['fr', 'en', 'es']
      })
    );

    socket.on('message', (raw) => {
      const payload = safeJsonParse(raw.toString());
      if (!payload || payload.type !== 'caption_config') return;

      const sourceLang = String(payload.sourceLanguage || '').trim().toLowerCase();
      if (!['auto', 'fr', 'en', 'es'].includes(sourceLang)) return;
      if (sourceLang === currentLanguage) return;

      currentLanguage = sourceLang;
      sendSessionUpdate();
      console.log(`[captions] transcription source language switched to ${currentLanguage}`);
    });

    socket.on('close', () => {
      browserClients.delete(socket);
    });

    socket.on('error', () => {
      browserClients.delete(socket);
    });
  });

  server.listen(CFG.captionsPort, CFG.captionsHost, () => {
    console.log(`[captions] Browser WS listening on ws://${CFG.captionsHost}:${CFG.captionsPort}`);
  });

  return { server, wss };
}

function shutdown() {
  console.log('[captions] Shutting down...');

  clearReconnectTimer();
  clearFfmpegRestartTimer();

  if (openAiWs) {
    try {
      openAiWs.close();
    } catch (_err) {
      // ignored
    }
  }

  if (ffmpegProc) {
    try {
      ffmpegProc.kill('SIGTERM');
    } catch (_err) {
      // ignored
    }
  }

  setTimeout(() => process.exit(0), 200).unref();
}

createCaptionServer();
connectOpenAi();
startFfmpeg();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[captions] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[captions] unhandledRejection:', err);
});
