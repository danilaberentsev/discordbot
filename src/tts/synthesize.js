import { config } from '../config.js';

export async function speakUma(session, text) {
  if (!config.cloudApiKey) {
    console.log(`[TTS выключен] ${text}`);
    return;
  }
  try {
    await session.speakText(text, { apiKey: config.cloudApiKey, voice: config.ttsVoice });
  } catch (err) {
    console.error('TTS:', err.message);
  }
}
