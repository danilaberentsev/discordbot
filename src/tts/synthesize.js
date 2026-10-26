import { config } from '../config.js';

export async function speakUma(session, text, onEnd) {
  if (!config.cloudApiKey) {
    console.log(`[TTS выключен] ${text}`);
    return;
  }
  try {
    await session.speakText(text, { apiKey: config.cloudApiKey, voice: config.ttsVoice, onEnd });
  } catch (err) {
    console.error('TTS:', err.message);
  }
}
