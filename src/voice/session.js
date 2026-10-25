import {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { get as httpsGet } from 'node:https';

const MUSIC_VOLUME_DEFAULT = 0.45;
const TTS_VOLUME_DEFAULT = 2.6;

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

async function trackResource(item, volume) {
  let url = item.url;
  if (typeof url === 'function') url = await url();
  if (!item.buffer) item.buffer = await downloadTrack(url);
  const stream = bufferStream(item.buffer, item.offset ?? 0, (bytes) => {
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

export class VoiceSession {
  constructor(connection) {
    this.connection = connection;
    this.musicVolume = MUSIC_VOLUME_DEFAULT;
    this.queue = [];
    this.current = null;
    this.starting = false;

    this.player = createAudioPlayer();
    connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.current = null;
      const next = this.queue.shift();
      if (next) this.start(next);
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
    // this.probe = setInterval(() => {
    //   console.log(
    //     `[probe] conn=${this.connection.state.status} subs=${this.player.subscribers.length} player=${this.player.state.status}`,
    //   );
    // }, 1000);
  }

  startNext() {
    if (this.starting) return;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return;
    const next = this.queue.shift();
    if (next) this.start(next);
  }

  async start(item) {
    this.starting = true;
    let started = false;
    try {
      const resource = item.kind === 'tts'
        ? await ttsResource(item.text, item.apiKey, item.voice)
        : await trackResource(item, this.musicVolume);
      if (this.player.state.status !== AudioPlayerStatus.Idle) {
        try {
          resource.playStream.destroy();
        } catch {
        }
        return;
      }
      this.current = item;
      this.currentResource = resource;
      this.player.play(resource);
      started = true;
    } catch (err) {
      console.error('Не удалось запустить элемент очереди:', err.message);
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

  async speakText(text, { apiKey, voice }) {
    const item = { kind: 'tts', text, apiKey, voice };
    const status = this.player.state.status;
    if (status === AudioPlayerStatus.Idle) {
      this.queue.unshift(item);
      this.startNext();
      return;
    }
    const resume = this.current && this.current.kind === 'track' ? this.current : null;
    this.queue = [item, ...(resume ? [resume] : []), ...this.queue];
    this.player.stop(true);
  }

  skip() {
    if (this.current || this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    }
  }

  stopPlaying() {
    this.queue = this.queue.filter((item) => item.kind === 'tts');
    this.current = null;
    this.player.stop(true);
  }

  changeVolume(delta) {
    this.musicVolume = clampVolume(this.musicVolume + delta);
    if (this.current?.kind === 'track') {
      this.currentResource?.volume?.setVolume(this.musicVolume);
    }
    return this.musicVolume;
  }

  destroy() {
    clearInterval(this.probe);
  }
}
