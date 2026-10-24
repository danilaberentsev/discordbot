const HTTP_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';

export async function recognizePcm(apiKey, pcm, { language = 'ru-RU', sampleRate = 48000 } = {}) {
  if (!pcm.length) return '';
  const url = `${HTTP_URL}?format=lpcm&sampleRateHertz=${sampleRate}&lang=${language}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: Buffer.from(pcm),
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.result ?? '';
}
