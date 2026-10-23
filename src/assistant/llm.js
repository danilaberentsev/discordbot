const LLM_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

export async function askYandexGpt(messages, {
  apiKey,
  folderId,
  model = 'yandexgpt-lite',
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
