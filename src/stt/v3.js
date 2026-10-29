import { credentials, Metadata, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENDPOINT = 'stt.api.cloud.yandex.net:443';
const MODEL = 'general:rc';
const DEADLINE_MS = 180_000;

const LINEAR16_PCM = 1;
const TEXT_NORMALIZATION_ENABLED = 1;
const WHITELIST = 1;
const FULL_DATA = 2;
const REAL_TIME = 1;

const here = dirname(fileURLToPath(import.meta.url));
const pkgDef = loadSync(join(here, 'proto', 'stt_service.proto'), {
  keepCase: false,
  longs: Number,
  enums: Number,
  defaults: false,
  oneofs: false,
  includeDirs: [join(here, 'proto')],
});
const { Recognizer } = loadPackageDefinition(pkgDef).speechkit.stt.v3;

let sharedClient = null;
function getClient() {
  if (!sharedClient) sharedClient = new Recognizer(ENDPOINT, credentials.createSsl());
  return sharedClient;
}

function sessionOptions({ language, sampleRate, audioProcessingType }) {
  return {
    sessionOptions: {
      recognitionModel: {
        model: MODEL,
        audioFormat: {
          rawAudio: {
            audioEncoding: LINEAR16_PCM,
            sampleRateHertz: sampleRate,
            audioChannelCount: 1,
          },
        },
        textNormalization: { textNormalization: TEXT_NORMALIZATION_ENABLED },
        languageRestriction: {
          restrictionType: WHITELIST,
          languageCode: [language],
        },
        audioProcessingType,
      },
      eouClassifier: { externalClassifier: {} },
    },
  };
}

function openStream(apiKey, { language, sampleRate, audioProcessingType }) {
  const metadata = new Metadata();
  metadata.set('authorization', `Api-Key ${apiKey}`);
  const stream = getClient().RecognizeStreaming(metadata, { deadline: Date.now() + DEADLINE_MS });
  stream.write(sessionOptions({ language, sampleRate, audioProcessingType }));
  return stream;
}

// FULL_DATA: фраза записана целиком -> отправляется разом -> eou
export function recognizePcmV3(apiKey, pcm, { language = 'ru-RU', sampleRate = 48000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!pcm.length) return resolve('');
    const stream = openStream(apiKey, { language, sampleRate, audioProcessingType: FULL_DATA });
    const finals = [];
    let partialText = '';

    stream.on('error', reject);
    stream.on('end', () => resolve((finals.join(' ') || partialText).trim()));
    stream.on('data', (response) => {
      if (response.final?.alternatives?.[0]?.text) {
        finals.push(response.final.alternatives[0].text);
      }
      if (response.partial?.alternatives?.[0]?.text) {
        partialText = response.partial.alternatives[0].text;
      }
    });

    const chunkBytes = Math.max(1, Math.floor(sampleRate * 2 * 0.2));
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      stream.write({ chunk: { data: pcm.subarray(offset, offset + chunkBytes) } });
    }
    stream.write({ eou: {} });
    stream.end();
  });
}

// REAL_TIME: стрим по мере поступления аудио; partial приходит во время речи
export function createRecognizer(apiKey, { language = 'ru-RU', sampleRate = 48000, onPartial } = {}) {
  const stream = openStream(apiKey, { language, sampleRate, audioProcessingType: REAL_TIME });
  const finals = [];
  let partialText = '';
  let error = null;

  stream.on('error', (err) => {
    error = err;
  });
  stream.on('data', (response) => {
    if (response.final?.alternatives?.[0]?.text) {
      finals.push(response.final.alternatives[0].text);
    }
    if (response.partial?.alternatives?.[0]?.text) {
      const text = response.partial.alternatives[0].text;
      if (text !== partialText) {
        partialText = text;
        onPartial?.(text);
      }
    }
  });

  return {
    write(chunk) {
      if (chunk.length) stream.write({ chunk: { data: chunk } });
    },
    end() {
      return new Promise((resolve, reject) => {
        if (error) return reject(error);
        stream.once('error', reject);
        stream.once('end', () => resolve((finals.join(' ') || partialText).trim()));
        stream.write({ eou: {} });
        stream.end();
      });
    },
    abort() {
      try {
        stream.cancel();
      } catch {
      }
    },
  };
}
