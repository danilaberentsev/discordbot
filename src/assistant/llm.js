const LLM_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

export async function askYandexGpt(messages, {
  apiKey,
  folderId,
  model = 'yandexgpt',
  maxTokens = 300,
  temperature = 0.6,
} = {}) {
  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      modelUri: `gpt://${folderId}/${model}`,
      completionOptions: { stream: false, temperature, maxTokens },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`YandexGPT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.result?.alternatives?.[0]?.message?.text?.trim() ?? '';
}

const FIX_SYSTEM = 'Ты правишь поисковый запрос к музыкальному сервису: пользователь что-то сказал по-русски, а тема запроса может быть английской песней или артистом, записанным русской транскрипцией. Перепиши английские слова латиницей в оригинальном написании. Пример: «эвризинг блэк» — «everything black». Отвечай только текстом после исправления, без кавычек, команд и пояснений.';

export async function fixUtterance(text, { apiKey, folderId }) {
  const fixed = await askYandexGpt([
    { role: 'system', text: FIX_SYSTEM },
    { role: 'user', text },
  ], { apiKey, folderId, temperature: 0, maxTokens: 100 });
  return fixed.replace(/[«»"']/g, '').trim() || text;
}
