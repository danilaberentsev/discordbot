const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function askDeepSeek(messages, {
  apiKey,
  model = 'deepseek-chat',
  maxTokens = 300,
  temperature = 0.6,
  responseFormat,
  signal,
  fetchImpl,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (responseFormat) body.response_format = responseFormat;
  const res = await doFetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? '';
}

const FIX_SYSTEM = 'Ты правишь поисковый запрос к музыкальному сервису: пользователь что-то сказал по-русски, а тема запроса может быть английской песней или артистом, записанным русской транскрипцией. Перепиши английские слова латиницей в оригинальном написании. Пример: «эвризинг блэк» — «everything black». Отвечай только текстом после исправления, без кавычек, команд и пояснений.';

export async function fixUtterance(text, { apiKey }) {
  const fixed = await askDeepSeek([
    { role: 'system', content: FIX_SYSTEM },
    { role: 'user', content: text },
  ], { apiKey, temperature: 0, maxTokens: 100 });
  return fixed.replace(/[«»"']/g, '').trim() || text;
}

const NORMALIZE_SYSTEM = `Ты — нейтральный классификатор голосовых команд музыкального бота. Не персонаж, не отвечай на вопросы. Разбери фразу пользователя на команду и верни ровно один JSON-объект, без пояснений и кавычек вокруг. Допустимые action: play | stop | skip | volume | leave | assistant.

Пример формы ответа:
{"action":"play","query":"everything black"}

Правила:
- generic-просьбы включить музыку без названия («включи музыку», «включи песню», «включи что-нибудь», «хиты») → {"action":"play","query":"__wave__"}.
- «моя волна», «мою волну», «моей волны» → {"action":"play","query":"__mywave__"}.
- просьба включить плейлист → оставь слово «плейлист» в query целиком: «включи три дня дождя плейлист» → {"action":"play","query":"три дня дождя плейлист"}.
- конкретный трек → {"action":"play","query":"<запрос с убранными филлерами: мне, пожалуйста, давай, просто, эту, песню, трек>"}.
- «стоп», «хватит», «выключи музыку» → {"action":"stop"}.
- «дальше», «следующий», «скип» → {"action":"skip"}.
- «тише» → {"action":"volume","delta":-0.15}; «громче» → {"action":"volume","delta":0.15}.
- «громкость на 50» → {"action":"volume","level":0.5} (level — доля от 0 до 1).
- «выйди», «уйди», «пока», «отключись» → {"action":"leave"}.
- если фраза НЕ команда (вопрос, болтовня) → верни только {"action":"assistant","text":"<исходная фраза дословно>"}, на вопрос не отвечай.
- не транслитерируй английские слова, не добавляй пояснений, вывод — только JSON.`;

const ACTIONS = new Set(['play', 'stop', 'skip', 'volume', 'leave', 'assistant']);
const PLAIN_ACTIONS = new Set(['stop', 'skip', 'leave']);

function validateCommand(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('normalizeCommand: не объект');
  if (!ACTIONS.has(obj.action)) throw new Error(`normalizeCommand: недопустимый action "${obj.action}"`);
  const out = { action: obj.action };
  switch (obj.action) {
    case 'play':
      if (typeof obj.query !== 'string' || !obj.query.trim()) {
        throw new Error('normalizeCommand: play без query');
      }
      out.query = obj.query.trim();
      break;
    case 'volume': {
      const hasLevel = typeof obj.level === 'number' && obj.level >= 0 && obj.level <= 1;
      const hasDelta = typeof obj.delta === 'number';
      if (hasLevel) out.level = obj.level;
      else if (hasDelta) out.delta = obj.delta;
      else throw new Error('normalizeCommand: volume без level/delta');
      break;
    }
    case 'assistant':
      if (typeof obj.text !== 'string' || !obj.text.trim()) {
        throw new Error('normalizeCommand: assistant без text');
      }
      out.text = obj.text.trim();
      break;
    case 'stop':
    case 'skip':
    case 'leave':
      break;
    default:
      break;
  }
  return out;
}

export async function normalizeCommand(text, {
  apiKey,
  timeoutMs = 5000,
  fetchImpl,
} = {}) {
  const content = await askDeepSeek([
    { role: 'system', content: NORMALIZE_SYSTEM },
    { role: 'user', content: text },
  ], {
    apiKey,
    temperature: 0,
    maxTokens: 300,
    responseFormat: { type: 'json_object' },
    signal: AbortSignal.timeout(timeoutMs),
    fetchImpl,
  });

  if (!content) throw new Error('normalizeCommand: пустой ответ модели');
  const parsed = JSON.parse(content);
  return validateCommand(parsed);
}
