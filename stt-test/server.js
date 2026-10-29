import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createRecognizer } from '../src/stt/v3.js';
import { recognizePcm } from '../src/stt/session.js';
import { findWakeToken, stripWake, parseCommand } from '../src/commands/parse.js';
import { config } from '../src/config.js';
import { SYSTEM } from '../src/assistant/context.js';
import { askDeepSeek } from '../src/assistant/llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/recorder-worklet.js': 'recorder-worklet.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const file = ROUTES[url];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const path = join(here, file);
  if (!existsSync(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[file.endsWith('.js') ? '.js' : '.html'] });
  res.end(readFileSync(path));
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  ws.stt = { recognizer: null, pcm: [], wakeFired: false, sampleRate: config.sttSampleRate };

  ws.on('message', (data, isBinary) => {
    if (isBinary) return onAudio(ws, data);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    onMessage(ws, msg).catch((err) => send(ws, { type: 'error', message: err.message }));
  });

  ws.on('close', () => {
    try {
      ws.stt.recognizer?.abort();
    } catch {
    }
  });
});

function onAudio(ws, buf) {
  const stt = ws.stt;
  if (!stt.recognizer) return;
  stt.pcm.push(buf);
  stt.recognizer.write(buf);
}

async function onMessage(ws, msg) {
  switch (msg.type) {
    case 'start':
      startSession(ws, msg);
      return;
    case 'stop':
      await stopSession(ws);
      return;
    case 'deepseek':
      await callDeepSeek(ws, msg);
      return;
    default:
      return;
  }
}

function startSession(ws, msg) {
  if (!config.cloudApiKey) {
    send(ws, { type: 'error', message: 'YANDEX_CLOUD_API_KEY не задан в .env — распознавание недоступно' });
    return;
  }
  const stt = ws.stt;
  try {
    stt.recognizer?.abort();
  } catch {
  }
  stt.recognizer = null;
  stt.pcm = [];
  stt.wakeFired = false;
  stt.sampleRate = msg.sampleRate || config.sttSampleRate;

  stt.recognizer = createRecognizer(config.cloudApiKey, {
    language: config.sttLanguage,
    sampleRate: stt.sampleRate,
    onPartial: (text) => {
      send(ws, { type: 'partial', text });
      if (stt.wakeFired) return;
      const wake = findWakeToken(text);
      if (!wake) return;
      stt.wakeFired = true;
      send(ws, { type: 'wake', token: wake });
    },
  });
  send(ws, {
    type: 'started',
    language: config.sttLanguage,
    sampleRate: stt.sampleRate,
    wakeWords: config.wakeWords,
  });
}

async function stopSession(ws) {
  const stt = ws.stt;
  const recognizer = stt.recognizer;
  stt.recognizer = null;
  if (!recognizer) return;

  const pcm = Buffer.concat(stt.pcm);
  const durationMs = Math.round((pcm.length / (stt.sampleRate * 2)) * 1000);

  if (pcm.length < stt.sampleRate * 2 * 0.3) {
    recognizer.abort();
    send(ws, { type: 'final', text: '', durationMs });
    send(ws, { type: 'error', message: 'Запись слишком короткая (меньше 0.3 с)' });
    return;
  }

  let text;
  try {
    text = await recognizer.end();
  } catch (err) {
    console.log('STT стрим не удался, фолбэк на FULL_DATA:', err.message);
    text = await recognizePcm(config.cloudApiKey, pcm, {
      language: config.sttLanguage,
      sampleRate: stt.sampleRate,
    });
  }

  send(ws, { type: 'final', text, durationMs });
  if (text) {
    send(ws, { type: 'steps', steps: buildSteps(text) });
  } else {
    send(ws, { type: 'error', message: 'Ничего не распознано' });
  }
}

function buildSteps(text) {
  const steps = [];

  steps.push({ key: 'final', title: 'STT — финальный текст', body: text });

  const { matched, rest, wakeToken } = stripWake(text);
  steps.push({
    key: 'stripwake',
    title: 'stripWake — убрать wake-слово',
    matched,
    wakeToken,
    rest,
  });

  if (matched && !rest) {
    steps.push({
      key: 'note',
      title: 'Команда не задана',
      body: 'Только wake-слово: бот открывает окно слушания (8 с) и ждёт команду без wake.',
    });
    return steps;
  }

  if (!matched) {
    steps.push({
      key: 'note',
      title: 'Wake-слово не найдено',
      body: 'Без wake-слова бот выполнит команду только внутри follow-up окна после предыдущего ответа ассистента.',
    });
    return steps;
  }

  const cmd = parseCommand(rest);
  steps.push({ key: 'parse', title: 'parseCommand — разбор команды', cmd });

  if (cmd.action === 'assistant') {
    steps.push({
      key: 'deepseek',
      title: '→ DeepSeek — сообщения для отправки',
      messages: [SYSTEM, { role: 'user', content: cmd.text }],
    });
  } else if (cmd.action === 'play') {
    const isWave = cmd.query === '__wave__' || cmd.query === '__mywave__';
    steps.push({
      key: 'music',
      title: '→ Яндекс Музыка',
      query: cmd.query,
      note: isWave
        ? 'Волна/моя волна — DeepSeek не участвует.'
        : 'Запрос пойдёт в instant-поиск. DeepSeek (fixUtterance) подключается, только если instant вернул 0 треков и в запросе есть кириллица.',
    });
  } else {
    steps.push({ key: 'command', title: '→ Команда бота', cmd });
  }

  return steps;
}

async function callDeepSeek(ws, msg) {
  if (!config.deepseekApiKey) {
    send(ws, { type: 'deepseek:error', message: 'DEEPSEEK_API_KEY не задан в .env' });
    return;
  }
  try {
    const answer = await askDeepSeek([SYSTEM, { role: 'user', content: msg.text }], {
      apiKey: config.deepseekApiKey,
    });
    send(ws, { type: 'deepseek:answer', answer });
  } catch (err) {
    send(ws, { type: 'deepseek:error', message: err.message });
  }
}

server.listen(PORT, () => {
  console.log(`STT-тест: http://localhost:${PORT}`);
  console.log(`  STT: ${config.cloudApiKey ? 'готов' : 'YANDEX_CLOUD_API_KEY не задан'}`);
  console.log(`  DeepSeek: ${config.deepseekApiKey ? 'готов' : 'DEEPSEEK_API_KEY не задан'}`);
});
