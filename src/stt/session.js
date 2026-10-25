import { recognizePcmV3 } from './v3.js';

const HTTP_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';

export async function recognizePcm(apiKey, pcm, opts = {}) {
  try {
    return await recognizePcmV3(apiKey, pcm, opts);
  } catch (err) {
    console.log('STT v3 не удался, фолбэк на v1:', err.message);
    return recognizePcmV1(apiKey, pcm, opts);
  }
}

async function recognizePcmV1(apiKey, pcm, { language = 'ru-RU', sampleRate = 48000 } = {}) {
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
