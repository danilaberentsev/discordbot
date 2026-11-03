import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GLADIA_TEST_PORT ?? 3001);
const API_KEY = process.env.GLADIA_API_KEY ?? '';
const REGION = process.env.GLADIA_REGION ?? 'eu-west';
const API_URL = 'https://api.gladia.io/v2/live';
const MODEL = 'solaria-1';
const STOP_TIMEOUT_MS = 8000;

// Happ Proxy mode отдаёт локальный SOCKS5 (обычно 127.0.0.1:10808).
// GLADIA_PROXY пустой — ходим напрямую (текущее поведение).
const PROXY = process.env.GLADIA_PROXY ?? '';
const PROXY_KIND = !PROXY ? 'none' : /^socks/i.test(PROXY) ? 'socks' : /^https?:/i.test(PROXY) ? 'http' : 'invalid';
const dispatcher = PROXY_KIND === 'socks'
  ? new Socks5ProxyAgent(PROXY)
  : PROXY_KIND === 'http'
    ? new ProxyAgent(PROXY)
    : undefined;
const wsAgent = PROXY_KIND === 'socks'
  ? new SocksProxyAgent(PROXY)
  : PROXY_KIND === 'http'
    ? new HttpsProxyAgent(PROXY)
    : undefined;

const FILES = {
  '/': 'gladia.html',
  '/gladia.html': 'gladia.html',
  '/recorder-worklet.js': 'recorder-worklet.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const file = FILES[url];
  if (!file) return notFound(res);
  const path = join(here, file);
  if (!existsSync(path)) return notFound(res);
  res.writeHead(200, { 'Content-Type': MIME[file.endsWith('.js') ? '.js' : '.html'] });
  res.end(readFileSync(path));
});

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

wss.on('connection', (ws) => {
  ws.gladia = null;
  ws.pending = null;
  ws.stopRequested = false;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      forwardAudio(ws, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    onMessage(ws, msg).catch((err) => send(ws, { type: 'error', message: err.message }));
  });

  ws.on('close', () => closeGladia(ws));
});

async function onMessage(ws, msg) {
  if (msg.type === 'start') return startSession(ws, msg);
  if (msg.type === 'stop') {
    // стоп пришёл, пока ещё идёт REST-init — запомним и остановим после старта
    if (!ws.gladia && Array.isArray(ws.pending)) {
      ws.stopRequested = true;
      return;
    }
    return stopSession(ws);
  }
}

async function startSession(ws, msg) {
  if (!API_KEY) {
    send(ws, { type: 'error', message: 'GLADIA_API_KEY не задан в .env' });
    return;
  }

  closeGladia(ws);
  ws.pending = [];
  ws.stopRequested = false;

  try {
    const sampleRate = Number(msg.sampleRate) || 48000;
    const languages = msg.langMode === 'ru' ? ['ru'] : ['ru', 'en'];

    const res = await undiciFetch(`${API_URL}?region=${encodeURIComponent(REGION)}`, {
      method: 'POST',
      headers: {
        'x-gladia-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        encoding: 'wav/pcm',
        sample_rate: sampleRate,
        bit_depth: 16,
        channels: 1,
        language_config: {
          languages,
          code_switching: languages.length > 1,
        },
        messages_config: {
          receive_partial_transcripts: true,
          receive_final_transcripts: true,
        },
      }),
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!res.ok) {
      throw new Error(`Gladia init ${res.status}: ${await res.text()}`);
    }

    const init = await res.json();
    const gws = new WebSocket(init.url, wsAgent ? { agent: wsAgent } : undefined);

    const state = {
      id: init.id,
      gws,
      opened: false,
      stopping: false,
      queue: [],
      finalText: '',
      doneTimer: null,
      resolveDone: null,
      done: null,
    };
    state.done = new Promise((resolve) => {
      state.resolveDone = resolve;
    });
    ws.gladia = state;

    // аудио, пришедшее пока шёл REST-init, не теряем
    if (ws.pending?.length) {
      state.queue.push(...ws.pending);
      ws.pending = [];
    }

    if (ws.stopRequested) {
      ws.stopRequested = false;
      stopSession(ws).catch((err) => send(ws, { type: 'error', message: err.message }));
    }

    gws.on('open', () => {
      state.opened = true;
      for (const chunk of state.queue) gws.send(chunk);
      state.queue = [];
      send(ws, { type: 'started', model: MODEL, sampleRate, languages });
      if (state.stopping) gws.send(JSON.stringify({ type: 'stop_recording' }));
      console.log(`[gladia] сессия ${state.id}: ${sampleRate} Гц, ${languages.join('+')}`);
    });

    gws.on('message', (data) => onGladiaMessage(ws, state, data));

    gws.on('error', (err) => {
      send(ws, { type: 'error', message: `Gladia WS: ${err.message}` });
    });

    gws.on('close', (code) => {
      console.log(`[gladia] сессия ${state.id} закрыта (${code})`);
      state.resolveDone?.();
      state.resolveDone = null;
    });
  } catch (err) {
    ws.pending = null;
    ws.stopRequested = false;
    throw err;
  }
}

function onGladiaMessage(ws, state, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (msg.type === 'transcript') {
    const text = msg.data?.utterance?.text ?? '';
    if (msg.data?.is_final) {
      if (text) {
        state.finalText = state.finalText ? `${state.finalText} ${text}` : text;
      }
      send(ws, { type: 'final', text: state.finalText });
      if (state.stopping) scheduleDone(state);
    } else {
      send(ws, { type: 'partial', text });
    }
    return;
  }

  if (msg.type === 'speech_start') {
    send(ws, { type: 'speech', active: true });
    return;
  }
  if (msg.type === 'speech_end' || msg.type === 'speech_stop') {
    send(ws, { type: 'speech', active: false });
    return;
  }
  if (msg.type === 'error') {
    send(ws, { type: 'error', message: msg.message ?? 'Gladia error' });
  }
}

function scheduleDone(state) {
  clearTimeout(state.doneTimer);
  state.doneTimer = setTimeout(() => {
    state.resolveDone?.();
    state.resolveDone = null;
  }, 300);
}

function forwardAudio(ws, buf) {
  const state = ws.gladia;
  if (!state) {
    if (Array.isArray(ws.pending)) ws.pending.push(buf);
    return;
  }
  if (!state.opened) {
    state.queue.push(buf);
    return;
  }
  if (state.gws?.readyState === WebSocket.OPEN) state.gws.send(buf);
}

async function stopSession(ws) {
  ws.stopRequested = false;
  const state = ws.gladia;
  if (!state) return;

  state.stopping = true;
  send(ws, { type: 'stopping' });

  if (state.gws?.readyState === WebSocket.OPEN) {
    state.gws.send(JSON.stringify({ type: 'stop_recording' }));
  }

  await Promise.race([state.done, sleep(STOP_TIMEOUT_MS)]);

  if (!state.finalText && state.id) {
    await fetchFinal(state).catch(() => {});
  }

  send(ws, { type: 'done', text: state.finalText });
  console.log(`[gladia] итог: ${state.finalText || '(пусто)'}`);

  ws.gladia = null;
  ws.pending = null;
  closeState(state);
}

async function fetchFinal(state) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(500);
    const res = await undiciFetch(`https://api.gladia.io/v2/live/${state.id}`, {
      headers: { 'x-gladia-key': API_KEY },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) continue;
    const json = await res.json();
    const text = json?.result?.transcription?.full_transcript
      ?? json?.result?.full_transcript
      ?? '';
    if (text) {
      state.finalText = text;
      return;
    }
  }
}

function closeGladia(ws) {
  const state = ws.gladia;
  ws.gladia = null;
  ws.pending = null;
  ws.stopRequested = false;
  if (state) closeState(state);
}

function closeState(state) {
  clearTimeout(state.doneTimer);
  state.doneTimer = null;
  try {
    state.resolveDone?.();
  } catch {}
  state.resolveDone = null;
  try {
    if (state.gws && state.gws.readyState !== WebSocket.CLOSED) state.gws.close();
  } catch {}
}

server.listen(PORT, () => {
  console.log(`Gladia STT-тест: http://localhost:${PORT}`);
  console.log(`  Gladia: ${API_KEY ? `готов (${REGION})` : 'GLADIA_API_KEY не задан'}`);
  console.log(`  Прокси: ${PROXY_KIND === 'none' ? 'выключен' : PROXY_KIND}`);
  if (PROXY_KIND === 'invalid') console.error('GLADIA_PROXY: ожидается socks5://... или http://..., прокси отключён');
});
