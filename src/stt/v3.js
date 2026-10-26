import { credentials, Metadata, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENDPOINT = 'stt.api.cloud.yandex.net:443';
const MODEL = 'general:rc';

const LINEAR16_PCM = 1;
const TEXT_NORMALIZATION_ENABLED = 1;
const WHITELIST = 1;
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

export function recognizePcmV3(apiKey, pcm, { language = 'ru-RU', sampleRate = 48000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!pcm.length) return resolve('');
    const client = new Recognizer(ENDPOINT, credentials.createSsl());
    const metadata = new Metadata();
    metadata.set('authorization', `Api-Key ${apiKey}`);

    const stream = client.RecognizeStreaming(metadata, { deadline: Date.now() + 15000 });
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

    stream.write({
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
          audioProcessingType: REAL_TIME,
        },
        eouClassifier: { externalClassifier: {} },
      },
    });

    const chunkBytes = Math.max(1, Math.floor(sampleRate * 2 * 0.2));
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      stream.write({ chunk: { data: pcm.subarray(offset, offset + chunkBytes) } });
    }
    stream.write({ eou: {} });
    stream.end();
  });
}
