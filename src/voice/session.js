import {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { Readable } from 'node:stream';

const MUSIC_VOLUME_DEFAULT = 0.45;
const ANNOUNCE_DUCK = 0.25;

function clampVolume(value) {
  return Math.min(1, Math.max(0.05, value));
}

async function streamFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось открыть поток трека: ${res.status}`);
  return Readable.fromWeb(res.body);
}

export class VoiceSession {
  constructor(connection) {
    this.connection = connection;
    this.musicVolume = MUSIC_VOLUME_DEFAULT;
    this.queue = [];
    this.current = null;

    this.musicPlayer = createAudioPlayer();
    this.voicePlayer = createAudioPlayer();
    connection.subscribe(this.musicPlayer);
    connection.subscribe(this.voicePlayer);

    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[voice] ${oldState.status} -> ${newState.status}`);
      }
    });
    this.musicPlayer.on(AudioPlayerStatus.Idle, () => {
      this.current = null;
      this.playNext();
    });
    this.musicPlayer.on('error', (err) => console.error('Плеер музыки:', err.message));
    this.musicPlayer.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[player] ${oldState.status} -> ${newState.status}`);
      }
    });
    this.voicePlayer.on('error', (err) => console.error('Плеер озвучки:', err.message));
  }

  playNext() {
    const next = this.queue.shift();
    if (next) this.startTrack(next);
  }

  async startTrack(item) {
    try {
      const stream = await streamFromUrl(item.url);
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      resource.volume.setVolume(this.musicVolume);
      this.current = resource;
      this.musicPlayer.play(resource);
    } catch (err) {
      console.error('Не удалось запустить трек:', err.message);
      this.playNext();
    }
  }

  async playTrack(item) {
    this.queue.push(item);
    if (this.musicPlayer.state.status !== AudioPlayerStatus.Playing && !this.current) {
      this.playNext();
    }
    return item;
  }

  skip() {
    if (this.musicPlayer.state.status !== AudioPlayerStatus.Idle || this.current) {
      this.musicPlayer.stop(true);
    }
  }

  stopPlaying() {
    this.queue = [];
    this.current = null;
    this.musicPlayer.stop(true);
  }

  changeVolume(delta) {
    this.musicVolume = clampVolume(this.musicVolume + delta);
    this.current?.volume?.setVolume(this.musicVolume);
    return this.musicVolume;
  }

  async speakText(text, { apiKey, voice }) {
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
    });

    const wasPlaying = this.musicPlayer.state.status === AudioPlayerStatus.Playing;
    if (wasPlaying) {
      this.current?.volume?.setVolume(this.musicVolume * ANNOUNCE_DUCK);
    }

    this.voicePlayer.play(resource);
    await new Promise((resolve) => {
      const onIdle = () => {
        this.voicePlayer.off(AudioPlayerStatus.Idle, onIdle);
        if (wasPlaying) {
          this.current?.volume?.setVolume(this.musicVolume);
        }
        resolve();
      };
      this.voicePlayer.on(AudioPlayerStatus.Idle, onIdle);
    });
  }
}
