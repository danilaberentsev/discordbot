import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const WS_URL = 'wss://transcribe.api.cloud.yandex.net/speech/v1/stt:recognize?websocket=true';

export class SpeechKitSession extends EventEmitter {
  constructor(apiKey, { language = 'ru-RU', sampleRate = 48000 } = {}) {
    super();
    this.language = language;
    this.sampleRate = sampleRate;
    this.lastPartial = '';
    this.open = false;
    this.closed = false;
    this.queue = [];

    this.ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Api-Key ${apiKey}` },
    });

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        event: { timeouts: { idleTimeout: '10s' } },
        config: {
          specification: {
            languageCode: this.language,
            audioEncoding: 'LINEAR16_PCM',
            sampleRateHertz: this.sampleRate,
            audioChannelCount: 1,
          },
        },
      }));
      this.open = true;
      for (const chunk of this.queue) this.ws.send(chunk, { binary: true });
      this.queue = [];
      this.emit('open');
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const event = message?.event ?? {};
      const text = message?.result?.hypotheses?.[0]?.text ?? '';
      if (!text) return;
      this.lastPartial = text;
      if (event.final) this.emit('final', text);
      else if (event.partial) this.emit('partial', text);
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      this.open = false;
      this.closed = true;
    });

    setTimeout(() => {
      if (!this.open && !this.closed) {
        this.emit('error', new Error('SpeechKit: таймаут подключения'));
      }
    }, 10000);
  }

  write(chunk) {
    if (this.closed) return;
    if (!this.open) {
      this.queue.push(chunk);
      return;
    }
    this.ws.send(chunk, { binary: true });
  }

  end() {
    if (this.closed) return;
    if (!this.open) {
      this.once('open', () => this.end());
      return;
    }
    this.ws.send(JSON.stringify({ event: { endOfStream: true } }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
    }
    this.open = false;
    this.emit('done');
  }
}
