import { EndBehaviorType } from '@discordjs/voice';
import { Transform } from 'node:stream';
import OpusScript from 'opusscript';
import { recognizePcm } from '../stt/session.js';

class OpusDecoder extends Transform {
  constructor(rate) {
    super();
    this.decoder = new OpusScript(rate, 1, OpusScript.Application.AUDIO);
  }

  _transform(chunk, encoding, done) {
    try {
      this.push(this.decoder.decode(chunk));
    } catch {
      console.warn('Пропущен битый opus-пакет');
    }
    done();
  }

  _destroy(err, done) {
    try {
      this.decoder.delete();
    } catch {
    }
    done(err);
  }
}

export class VoiceListener {
  constructor(connection, botId, { apiKey, language, sampleRate, onUtterance, guild } = {}) {
    this.connection = connection;
    this.botId = botId;
    this.apiKey = apiKey ?? '';
    this.language = language ?? 'ru-RU';
    this.sampleRate = sampleRate ?? 48000;
    this.onUtterance = onUtterance ?? null;
    this.guild = guild ?? null;
    this.users = new Map();
    this.busy = new Set();
    this.speaking = connection.receiver.speaking;
    this.handleStart = null;
    this.handleStop = null;
  }

  resolveName(userId) {
    const member = this.guild?.voiceStates?.cache?.get(userId)?.member
      ?? this.guild?.members?.cache?.get(userId);
    return member?.displayName ?? userId;
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
    const entry = { sub: null, dec: null, chunks: [], bytes: 0, startedAt: Date.now() };
    this.users.set(userId, entry);

    if (!this.apiKey) {
      console.log('Речь замечена, но YANDEX_CLOUD_API_KEY не задан, распознавание выключено');
      return;
    }
    if (this.busy.has(userId)) return;

    try {
      const sub = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
      });
      const decoder = new OpusDecoder(this.sampleRate);
      decoder.on('data', (chunk) => {
        entry.chunks.push(chunk);
        entry.bytes += chunk.length;
      });
      decoder.on('error', (err) => console.error('Opus:', err.message));
      sub.on('error', (err) => console.error('Поток речи:', err.message));
      sub.pipe(decoder);

      entry.sub = sub;
      entry.dec = decoder;
    } catch (err) {
      console.error('Не удалось начать запись фразы:', err);
    }
  }

  endUser(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    const pcm = Buffer.concat(entry.chunks);
    const startedAt = entry.startedAt;
    try {
      entry.sub?.destroy();
    } catch {
    }
    try {
      entry.dec?.destroy();
    } catch {
    }
    this.users.delete(userId);

    if (pcm.length < this.sampleRate * 2 * 0.3) return;
    if (this.busy.has(userId)) return;
    this.busy.add(userId);
    const text = recognizePcm(this.apiKey, pcm, {
      language: this.language,
      sampleRate: this.sampleRate,
    });
    text.then((value) => {
      if (value) {
        const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
        console.log(`[${time}] Услышала (${this.resolveName(userId)}): ${value}`);
        this.onUtterance?.(value, userId, startedAt);
      }
    }).catch((err) => console.error('STT:', err.message)).finally(() => {
      this.busy.delete(userId);
    });
  }

  closeUser(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    try {
      entry.sub?.destroy();
    } catch {
    }
    try {
      entry.dec?.destroy();
    } catch {
    }
    this.users.delete(userId);
  }
}
