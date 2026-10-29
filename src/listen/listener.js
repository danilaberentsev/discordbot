import { EndBehaviorType } from '@discordjs/voice';
import { Transform } from 'node:stream';
import OpusScript from 'opusscript';
import { recognizePcm } from '../stt/session.js';
import { createRecognizer } from '../stt/v3.js';
import { findWakeToken } from '../commands/parse.js';

class OpusDecoder extends Transform {
  constructor(rate) {
    super();
    this.decoder = new OpusScript(rate, 1, OpusScript.Application.AUDIO);
    this.brokenPackets = 0;
  }

  _transform(chunk, encoding, done) {
    try {
      this.push(this.decoder.decode(chunk));
    } catch {
      this.brokenPackets++;
    }
    done();
  }

  _destroy(err, done) {
    if (this.brokenPackets) {
      console.log(`Пропущено битых opus-пакетов: ${this.brokenPackets}`);
    }
    try {
      this.decoder.delete();
    } catch {
    }
    done(err);
  }
}

export class VoiceListener {
  constructor(connection, botId, { apiKey, language, sampleRate, onUtterance, onWake, onEnd, onSpeechStart, guild } = {}) {
    this.connection = connection;
    this.botId = botId;
    this.apiKey = apiKey ?? '';
    this.language = language ?? 'ru-RU';
    this.sampleRate = sampleRate ?? 48000;
    this.onUtterance = onUtterance ?? null;
    this.onWake = onWake ?? null;
    this.onEnd = onEnd ?? null;
    this.onSpeechStart = onSpeechStart ?? null;
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
    this.handleStop = (userId) => {
      this.endUser(userId).catch((err) => console.error('endUser:', err.message));
    };
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
    const entry = {
      sub: null, dec: null, recognizer: null, chunks: [], bytes: 0, startedAt: Date.now(), wakeFired: false,
    };
    this.users.set(userId, entry);
    this.onSpeechStart?.(userId);

    if (!this.apiKey) {
      console.log('Речь замечена, но YANDEX_CLOUD_API_KEY не задан, распознавание выключено');
      return;
    }
    if (this.busy.has(userId)) return;

    try {
      const sub = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const recognizer = createRecognizer(this.apiKey, {
        language: this.language,
        sampleRate: this.sampleRate,
        onPartial: (text) => {
          if (entry.wakeFired) return;
          const wake = findWakeToken(text);
          if (!wake) return;
          entry.wakeFired = true;
          const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
          console.log(`[${time}] Wake (${this.resolveName(userId)}): «${wake}»`);
          this.onWake?.(userId);
        },
      });
      entry.recognizer = recognizer;

      const decoder = new OpusDecoder(this.sampleRate);
      decoder.on('data', (chunk) => {
        entry.chunks.push(chunk);
        entry.bytes += chunk.length;
        recognizer.write(chunk);
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

  async endUser(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    this.onEnd?.(userId);
    const pcm = Buffer.concat(entry.chunks);
    const startedAt = entry.startedAt;
    const recognizer = entry.recognizer;
    this.destroyEntry(entry);
    this.users.delete(userId);

    if (pcm.length < this.sampleRate * 2 * 0.3 || this.busy.has(userId)) {
      recognizer?.abort();
      return;
    }
    this.busy.add(userId);

    try {
      const text = await this.finalizeText(recognizer, pcm);
      if (text) {
        const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
        console.log(`[${time}] Услышала (${this.resolveName(userId)}): ${text}`);
        this.onUtterance?.(text, userId, startedAt);
      }
    } catch (err) {
      console.error('STT:', err.message);
    } finally {
      this.busy.delete(userId);
    }
  }

  async finalizeText(recognizer, pcm) {
    if (!recognizer) {
      return recognizePcm(this.apiKey, pcm, {
        language: this.language,
        sampleRate: this.sampleRate,
      });
    }
    try {
      return await recognizer.end();
    } catch (err) {
      console.log('STT стрим не удался, фолбэк на FULL_DATA:', err.message);
      return recognizePcm(this.apiKey, pcm, {
        language: this.language,
        sampleRate: this.sampleRate,
      });
    }
  }

  closeUser(userId) {
    const entry = this.users.get(userId);
    if (!entry) return;
    this.destroyEntry(entry);
    entry.recognizer?.abort();
    this.users.delete(userId);
  }

  destroyEntry(entry) {
    try {
      entry.sub?.destroy();
    } catch {
    }
    try {
      entry.dec?.destroy();
    } catch {
    }
  }
}
