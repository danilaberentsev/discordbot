# AGENTS.md

Инструкции для AI-агентов, продолжающих разработку этого проекта.

## Контекст

Discord-бот «Аделина» (пакет `discordbot-alisa`) на Node.js (ESM, `type: module`). Голосовой канал: wake-слово → речь в текст (Yandex SpeechKit) → команда (музыка Яндекс Музыки / вопрос YandexGPT) → ответ голосом (SpeechKit TTS).

Общение с пользователем — по-русски. Проект pet/экспериментальный: код без лишних комментариев, стиль минималистичный, ESM-импорты, `console.log` для логов.

## Среда

- Windows 10/11, shell — bash (Git Bash) внутри PowerShell-хоста.
- Node 24 (nvm, глобально, менять нельзя). `npm` запускать как `npm.cmd`, если обычный `npm` блокируется execution policy.
- Нет Python → `@discordjs/opus` не собирается; используется `opusscript` + `libsodium-wrappers`.
- `ffmpeg-static` установлен (`node_modules/ffmpeg-static/ffmpeg.exe`), скрипты пакета разрешены через `allowScripts` в package.json.
- `.env` содержит реальные токены, в git не попадает. Не выводить секреты в чат/логи.

## Запуск и проверка

```bash
npm start                       # запуск бота
npm run dev                     # запуск с авто-рестартом (nodemon)
node --check src/...            # синтаксис
```

Проверка логики без Discord (сессия-заглушка):

```bash
node -e "require('dotenv').config(); Promise.all([import('./src/music/client.js'), import('./src/commands/dispatch.js')]).then(async ([{ YandexMusicClient }, { playMusic }]) => { const music = new YandexMusicClient(process.env.YANDEX_MUSIC_TOKEN); const session = { playTrack: async (i) => i }; console.log(await playMusic(session, music, 'everything black')); })"
```

Тест TTS:

```bash
node -e "require('dotenv').config(); fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', { method: 'POST', headers: { Authorization: 'Api-Key ' + process.env.YANDEX_CLOUD_API_KEY }, body: new URLSearchParams({ text: 'привет', voice: 'alena', lang: 'ru-RU', format: 'oggopus' }) }).then((r) => console.log(r.status))"
```

Тест STT v3 (gRPC, тишина 1 сек — должно подключиться без ошибки и 403):

```bash
node --input-type=module -e "import 'dotenv/config'; const { recognizePcmV3 } = await import('./src/stt/v3.js'); const r = await recognizePcmV3(process.env.YANDEX_CLOUD_API_KEY, Buffer.alloc(48000*2), { language: 'ru-RU', sampleRate: 48000 }); console.log('result:', JSON.stringify(r))"
```

Тест STT v1 (синхронный HTTP, фолбэк, `lpcm` 48k):

```bash
node -e "require('dotenv').config(); fetch('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?format=lpcm&sampleRateHertz=48000&lang=ru-RU', { method: 'POST', headers: { Authorization: 'Api-Key ' + process.env.YANDEX_CLOUD_API_KEY }, body: Buffer.alloc(48000) }).then(async (r) => console.log(r.status, await r.text()))"
```

## Карта файлов

- `src/index.js` — клиент Discord, регистрация слеш-команд, `handleUtterance`, сессии гильдий, автовыход.
- `src/config.js` — единственное место чтения env (кроме `dispatch.js`, где ключи GPT читаются для фиксера).
- `src/voice/session.js` — плеер, очередь, скачивание mp3, TTS-ресурс, громкости.
- `src/voice/connection.js` — join с `selfDeaf: false`, `debug: true` (debug можно убрать).
- `src/listen/listener.js` — подписка на речь, opus→PCM, буфер фразы, вызов `recognizePcm`.
- `src/stt/session.js` — `recognizePcm(apiKey, pcm, {language, sampleRate})`: v3, при ошибке фолбэк на v1 HTTP.
- `src/stt/v3.js` — `recognizePcmV3`, gRPC-стриминг SpeechKit v3 (LPCM → `final`/`partial` текст).
- `src/stt/proto/` — proto-файлы SpeechKit v3 (полный `stt.proto` из cloudapi + урезанный `stt_service.proto`).
- `src/tts/synthesize.js` — `speakUma(session, text)`, проверяет наличие ключа.
- `src/music/client.js` — `searchTracks`, `searchAll`, `albumTracks`, `normalizeTrack`, `playableUrl`.
- `src/commands/parse.js` — `normalize`, `stripWake`, `parseCommand`.
- `src/commands/dispatch.js` — `runMusicCommand`, `playMusic`, выбор трека из кандидатов.
- `src/commands/translit.js` — `translit`, `translitFallbacks`.
- `src/assistant/llm.js` — `askYandexGpt` (модель по умолчанию `yandexgpt`), `fixUtterance`.
- `src/assistant/context.js` — история диалога, системный промпт «Аделина».

## Инварианты, которые нельзя ломать

1. **Один AudioPlayer на VoiceConnection.** В `@discordjs/voice` 0.19 второй `connection.subscribe(player)` молча отписывает первый. Музыка и TTS — одна очередь (`kind: 'track' | 'tts'`) в `VoiceSession`. Не добавлять второй плеер.
2. **Не стримить mp3 напрямую в плеер.** CDN Яндекса рвёт длинные соединения (`terminated` undici / `aborted` https). `downloadTrack()` качает файл целиком в память, затем играет; обязательно следовать 3xx (`get-mp3` отдаёт 308).
3. **Громкость через `resource.volume.setVolume`** (в 0.19 нет `volumeTransformer`). Музыка `MUSIC_VOLUME_DEFAULT = 0.45`, TTS `TTS_VOLUME_DEFAULT = 1.6`.
4. **STT — v3 gRPC-стриминг, фолбэк на v1 HTTP.** v3 — bidirectional gRPC `speechkit.stt.v3.Recognizer/RecognizeStreaming` на `stt.api.cloud.yandex.net:443`, авторизация через metadata `authorization: Api-Key <key>`, аудио raw LPCM 16-bit. WebSocket-эндпоинты (хосты `transcribe.api.cloud.yandex.net`) отдают 403 — это v2 async REST, не использовать и не возвращать WS-код. При ошибке v3 `src/stt/session.js` падает на v1 `POST stt.api.cloud.yandex.net/speech/v1/stt:recognize?format=lpcm&...`.
5. **Поиск: `type=all` и блок `best`.** `type=track` не находит часть каталога (пример: Unlike Pluto — Everything Black). Если `best.type === 'album'` — тянуть треки через `/albums/{id}/with-tracks` (не `/albums/{id}/tracks` — 404 для синглов). Если `best.type` — не track/album и треков нет, возвращать `null` (иначе падение на `undefined.artists`).
6. **Ссылка на mp3 из `download-info` живёт ~1 минуту**; формула: `md5(SIGN_SALT + path.slice(1) + s)`, URL `https://{host}/get-mp3/{sign}/{ts}{path}`. Заголовок `X-Yandex-Music-Client` обязателен для download-info.
7. **Wake-слова берутся из `.env`**, если переменная задана — она переопределяет дефолт в `config.js`. При смене wake-слова проверять `.env`, а не только код.
8. **TTS v1 НЕ поддерживает `profanityFilter`** (400 unexpected field). Не добавлять этот параметр.
9. `speakText` прерывает текущий трек и ставит его обратно в очередь после озвучки — сохранять это поведение при правках очереди.

## Особенности выбора трека (dispatch.js)

- Сначала `pickTrack` по исходному запросу. `scoreTrack`: +10 за каждое слово запроса в «артист + название», +20 за полную подстроку, +30 за точное совпадение названия.
- Если score < 20 (или результата нет) — кандидаты: GPT-фикс запроса (`fixUtterance`) + `translitFallbacks`. Все кандидаты прогоняются через `pickTrack`.
- Победитель: `rank = лайки альбома + score * 0.3`. Лайки доминируют, потому что одноимённых треков много (рабочий пример: «еверифинк блек» → Unlike Pluto — Everything Black, а не ARCHANGELZZ).
- `best` в API нестабилен между запросами, поэтому нельзя полагаться на единственный вызов.
- Смешанные запросы («poli сестра») — известная слабость: непонятно, какой язык/написание нужно. Улучшения приветствуются, но проверяй на реальном API.

## Логи и отладка

Ключевые строки: `Услышала (id)`, `Голос -> команда`, `Поиск «...»: треков N, best ...`, `Кандидат «...»`, `Выбран трек`, `[player]`, `[voice]`.

Probe-интервал в `VoiceSession` закомментирован — при отладке звука можно временно включить.

## TODO / известные слабости

- Кэш скачанных mp3 (сейчас каждый раз качается заново).
- «Смешанный язык» запросов (латиница + кириллица в одном названии).
- `dispatch.js` читает env напрямую для GPT-фиксера — при рефакторинге перенести в `config.js`.
- Убрать `debug: true` из `voice/connection.js` перед продакшеном.
- Нет тестов; при добавлении — Vitest/Jest не настроены, выбирать осознанно.
- Пакет всё ещё называется `discordbot-alisa`, бот — «Аделина».

## Git

- Только по явной просьбе: не коммитить, не пушить.
- `.env`, `node_modules`, временные файлы (`tmp.ogg`, `tmp.pcm`) не должны попадать в git. Случайный файл `nul` (артефакт Windows-редиректа) удалять.
- Перед коммитом: `git status`, `git diff`, прогнать `node --check` по изменённым файлам.
