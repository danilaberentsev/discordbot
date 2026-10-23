import { EndBehaviorType } from '@discordjs/voice';
import { opus } from 'prism-media';
import { SpeechKitSession } from '../stt/session.js';

export class VoiceListener {
  constructor(connection, botId, { apiKey, language, sampleRate, onUtterance } = {}) {
    this.connection = connection;
    this.botId = botId;
    this.apiKey = apiKey ?? '';
    this.language = language ?? 'ru-RU';
    this.sampleRate = sampleRate ?? 48000;
    this.onUtterance = onUtterance ?? null;
    this.users = new Map();
    this.speaking = connection.receiver.speaking;
    this.handleStart = null;
    this.handleStop = null;
  }

  start() {
    if (this.handleStart) return;
    this.handleStart = (userId) => this.beginUser(userId);
    this.handleStop = (userId) => this.endUser(userId);
    this.speaking.on('start', this.handleStart);
    this.speaking.on('end', this.handleStop);
  }

  stop() {
    if (this.handleStart) {
      this.speaking.off('start', this.handleStart);
      this.speaking.off('end', this.handleStop);
      this.handleStart = null;
      this.handleStop = null;
    }
    for (const userId of [...this.users.keys()]) {
      this.closeUser(userId);
    }
  }

  beginUser(userId) {
    if (userId === this.botId || this.users.has(userId)) return;
    const entry = { sub: null, dec: null, sess: null, timer: null };
    this.users.set(userId, entry);

    if (!this.apiKey) {
      console.log('Речь замечена, но YANDEX_CLOUD_API_KEY не задан, распознавание выключено');
      return;
    }

    try {
      const session = new SpeechKitSession(this.apiKey, {
        language: this.language,
        sampleRate: this.sampleRate,
      });
      session.on('partial', (text) => console.log(`partial: ${text}`));
      session.on('final', (text) => {
        if (text) this.onUtterance?.(text, userId);
      });
      session.on('error', (err) => console.error('STT:', err.message));

      const sub = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
      });
      const decoder = new opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: this.sampleRate,
      });
      decoder.on('data', (chunk) => session.write(chunk));
      sub.pipe(decoder);

      entry.sub = sub;
      entry.dec = decoder;
      entry.sess = session;
    } catch (err) {
      console.error('Не удалось начать распознавание:', err);
    }
  }

  endUser(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    entry.sess?.end();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.closeUser(userId), 3000);
  }

  closeUser(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.sub?.destroy();
    } catch {
    }
    try {
      entry.dec?.destroy();
    } catch {
    }
    try {
      entry.sess?.close();
    } catch {
    }
    this.users.delete(userId);
  }
}
