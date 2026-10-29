import {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { get as httpsGet } from 'node:https';

const MUSIC_VOLUME_DEFAULT = 0.20;
const TTS_VOLUME_DEFAULT = 2.6;
const CHIME_VOLUME = 1.0;

function clampVolume(value) {
  return Math.min(1, Math.max(0.05, value));
}

function bufferStream(buffer, start, onProgress) {
  let offset = start;
  return new Readable({
    read() {
      if (offset >= buffer.length) {
        this.push(null);
        return;
      }
      const chunk = buffer.subarray(offset, Math.min(offset + 64 * 1024, buffer.length));
      offset += chunk.length;
      onProgress?.(offset);
      this.push(chunk);
    },
  });
}

const TRACK_CACHE = new Map();
const TRACK_CACHE_MAX = 30;

function cacheTrack(id, buffer) {
  if (!id) return;
  TRACK_CACHE.delete(id);
  TRACK_CACHE.set(id, buffer);
  if (TRACK_CACHE.size > TRACK_CACHE_MAX) {
    TRACK_CACHE.delete(TRACK_CACHE.keys().next().value);
  }
}

async function trackResource(item, volume) {
  let buffer = item.buffer;
  if (!buffer && item.id && TRACK_CACHE.has(item.id)) {
    buffer = TRACK_CACHE.get(item.id);
  }
  if (!buffer) {
    let url = item.url;
    if (typeof url === 'function') url = await url();
    buffer = await downloadTrack(url);
    if (item.id) cacheTrack(item.id, buffer);
  }
  item.buffer = buffer;
  const stream = bufferStream(buffer, item.offset ?? 0, (bytes) => {
    item.offset = bytes;
  });
  const resource = createAudioResource(stream, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume?.setVolume(volume);
  return resource;
}

function downloadTrack(rawUrl, depth = 5) {
  if (depth <= 0) return Promise.reject(new Error('Слишком много редиректов'));
  return new Promise((resolve, reject) => {
    const req = httpsGet(rawUrl, (res) => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, rawUrl).toString();
        downloadTrack(next, depth - 1).then(resolve, reject);
        return;
      }
      if (code !== 200 && code !== 206) {
        res.resume();
        reject(new Error(`Поток трека: HTTP ${code}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) reject(new Error('Пустой трек'));
        else resolve(buffer);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Загрузка трека зависла'));
    });
  });
}

async function ttsResource(text, apiKey, voice) {
  const res = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      text,
      voice,
      lang: 'ru-RU',
      format: 'oggopus',
      sampleRateHertz: '48000',
      emotion: 'neutral',
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  const resource = createAudioResource(Readable.fromWeb(res.body), {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });
  resource.volume?.setVolume(TTS_VOLUME_DEFAULT);
  return resource;
}

// мягкий колокольчик (stereo 16-bit LE, 48k) для отклика на wake-слово
let chimeBuffer = null;
function getChimeBuffer() {
  if (chimeBuffer) return chimeBuffer;
  const sampleRate = 48000;
  const notes = [
    { freq: 659.25, start: 0, dur: 0.22 },    // E5
    { freq: 987.77, start: 0.11, dur: 0.22 }, // B5 (квинта)
  ];
  const total = 0.33;
  const n = Math.floor(sampleRate * total);
  const buf = Buffer.alloc(n * 4);
  const decay = 22;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (const { freq, start, dur } of notes) {
      if (t >= start && t < start + dur) {
        const x = t - start;
        const env = Math.min(1, x / 0.004) * Math.exp(-x * decay);
        const tone = Math.sin(2 * Math.PI * freq * x)
          + 0.35 * Math.sin(2 * Math.PI * freq * 2 * x)
          + 0.12 * Math.sin(2 * Math.PI * freq * 3 * x);
        s += tone * env;
      }
    }
    const v = Math.max(-1, Math.min(1, s * 0.55));
    const s16 = Math.round(v * 32767);
    buf.writeInt16LE(s16, i * 4);
    buf.writeInt16LE(s16, i * 4 + 2);
  }
  chimeBuffer = buf;
  return buf;
}

export class VoiceSession {
  constructor(connection, tts = {}) {
    this.connection = connection;
    this.musicVolume = MUSIC_VOLUME_DEFAULT;
    this.queue = [];
    this.current = null;
    this.starting = false;
    this.startToken = 0;
    this.waveRefill = null;
    this.tts = tts;
    this.onTrackStart = null;
    this.onIdle = null;
    this.ducked = false;
    this.duckTimer = null;

    this.player = createAudioPlayer();
    connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      const finished = this.current;
      this.current = null;
      finished?.onEnd?.();
      const next = this.queue.shift();
      if (next) this.start(next);
      else if (this.waveRefill) this.waveRefill();
      else this.onIdle?.();
    });
    this.player.on('error', (err) => console.error('Плеер:', err.message));
    this.player.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[player] ${oldState.status} -> ${newState.status}`);
      }
    });
    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[voice] ${oldState.status} -> ${newState.status}`);
      }
    });
  }

  startNext() {
    if (this.starting) return;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return;
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  async start(item) {
    if (item.kind === 'track' && item.announce && this.tts?.apiKey) {
      const announce = item.announce;
      delete item.announce;
      this.queue.unshift(item);
      this.queue.unshift({ kind: 'tts', text: announce, apiKey: this.tts.apiKey, voice: this.tts.voice });
      this.startNext();
      return;
    }
    const token = ++this.startToken;
    this.starting = true;
    let started = false;
    try {
      const resource = item.kind === 'tts'
        ? await ttsResource(item.text, item.apiKey, item.voice)
        : item.kind === 'chime'
          ? item.resource
          : await trackResource(item, this.ducked ? 0 : this.musicVolume);
      if (token !== this.startToken || this.player.state.status !== AudioPlayerStatus.Idle) {
        try {
          resource.playStream.destroy();
        } catch {
        }
        return;
      }
      this.current = item;
      this.currentResource = resource;
      this.player.play(resource);
      if (item.kind === 'track') this.onTrackStart?.(item);
      started = true;
    } catch (err) {
      console.error('Не удалось запустить элемент очереди:', err.message, err.cause ?? '');
    } finally {
      this.starting = false;
    }
    if (!started) this.startNext();
  }

  async playTrack(item) {
    item.kind = 'track';
    this.queue.push(item);
    this.startNext();
    return item;
  }

  playNext(item) {
    item.kind = 'track';
    this.queue.unshift(item);
    this.startNext();
    return item;
  }

  setWaveRefill(fn) {
    this.waveRefill = fn;
  }

  playInterrupting(item) {
    const status = this.player.state.status;
    if (status === AudioPlayerStatus.Idle) {
      if (this.starting) this.startToken++;
      this.queue.unshift(item);
      this.startNext();
      return;
    }
    const resume = this.current && this.current.kind === 'track' ? this.current : null;
    this.queue = [item, ...(resume ? [resume] : []), ...this.queue];
    this.player.stop(true);
  }

  speakText(text, { apiKey, voice, onEnd } = {}) {
    this.playInterrupting({ kind: 'tts', text, apiKey, voice, onEnd });
  }

  playChime() {
    const resource = createAudioResource(Readable.from(getChimeBuffer()), {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume?.setVolume(CHIME_VOLUME);
    this.playInterrupting({ kind: 'chime', resource });
  }

  skip() {
    this.startToken++;
    if (this.current || this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    }
  }

  pause() {
    this.player.pause();
  }

  unpause() {
    this.player.unpause();
  }

  stopPlaying() {
    this.waveRefill = null;
    this.startToken++;
    this.queue = [];
    this.current = null;
    this.player.stop(true);
  }

  changeVolume(delta) {
    return this.setVolume(this.musicVolume + delta);
  }

  setVolume(value) {
    this.musicVolume = clampVolume(value);
    this.applyMusicVolume();
    return this.musicVolume;
  }

  // приглушить музыку (0) на время голосовой команды, не трогая musicVolume
  duckMusic() {
    if (this.ducked) return;
    this.ducked = true;
    this.applyMusicVolume();
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => this.unduckMusic(), 30000);
  }

  unduckMusic() {
    if (!this.ducked) return;
    this.ducked = false;
    clearTimeout(this.duckTimer);
    this.applyMusicVolume();
  }

  applyMusicVolume() {
    const volume = this.ducked ? 0 : this.musicVolume;
    if (this.current?.kind === 'track') {
      this.currentResource?.volume?.setVolume(volume);
    }
  }

  destroy() {
    this.startToken++;
    this.queue = [];
    this.waveRefill = null;
    clearTimeout(this.duckTimer);
    try {
      this.player.stop(true);
    } catch {
    }
  }
}
