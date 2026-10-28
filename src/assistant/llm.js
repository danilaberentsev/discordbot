const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function askDeepSeek(messages, {
  apiKey,
  model = 'deepseek-chat',
  maxTokens = 300,
  temperature = 0.6,
} = {}) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
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
