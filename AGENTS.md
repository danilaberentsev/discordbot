# AGENTS.md

Инструкции для AI-агентов, продолжающих разработку этого проекта.

## Контекст

Discord-бот «Маруся» (пакет `discordbot-marusya`) на Node.js (ESM, `type: module`). Голосовой канал: wake-слово → речь в текст (Yandex SpeechKit) → команда (музыка Яндекс Музыки / вопрос YandexGPT) → ответ голосом (SpeechKit TTS).

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

- `src/index.js` — клиент Discord, регистрация слеш-команд, `handleUtterance`, сессии гильдий, автовход/автопереход/автовыход, сообщение «сейчас играет» с кнопками (`buildNowPlayingContent`/`updateNowPlaying`/`handleNowPlayingButton`).
- `src/config.js` — единственное место чтения env (кроме `dispatch.js`, где ключи GPT читаются для фиксера).
- `src/voice/session.js` — плеер, очередь, скачивание mp3, TTS-ресурс, громкости, звуковой сигнал (`playChime`).
- `src/voice/connection.js` — join с `selfDeaf: false`, `debug: true` (debug можно убрать).
- `src/listen/listener.js` — подписка на речь, opus→PCM, стриминг в STT (REAL_TIME), детект wake в `partial` (колбэк `onWake`), фолбэк на FULL_DATA.
- `src/stt/session.js` — `recognizePcm(apiKey, pcm, {language, sampleRate})`: v3, при ошибке фолбэк на v1 HTTP.
- `src/stt/v3.js` — `recognizePcmV3` (FULL_DATA) и `createRecognizer` (REAL_TIME-стрим с `onPartial`), gRPC SpeechKit v3 (LPCM → `final`/`partial` текст).
- `src/stt/proto/` — proto-файлы SpeechKit v3 (полный `stt.proto` из cloudapi + урезанный `stt_service.proto`).
- `src/tts/synthesize.js` — `speakUma(session, text)`, проверяет наличие ключа.
- `src/music/client.js` — `instantSearch` (instant/mixed, type=track), `instantPlaylists`, `playlistTracks`, `chart` (топ-чарт), `normalizeTrack`, `playableUrl`.
- `src/commands/parse.js` — `normalize`, `cleanQuery` (стоп-слова), `isWaveIntent`, `stripWake`/`hasWakeWord` (fuzzy wake-матчинг), `parseCommand`.
- `src/commands/dispatch.js` — `runMusicCommand`, `playMusic`, `playWave` (очередь из чарта), instant-поиск трека/плейлиста.
- `src/commands/translit.js` — `translitFallbacks` (транслит-кандидаты для фикса кириллицы).
- `src/assistant/llm.js` — `askDeepSeek` (OpenAI-совместимый API DeepSeek, модель по умолчанию `deepseek-chat`), `fixUtterance`.
- `src/assistant/context.js` — история диалога, системный промпт «Маруся».

## Инварианты, которые нельзя ломать

1. **Один AudioPlayer на VoiceConnection.** В `@discordjs/voice` 0.19 второй `connection.subscribe(player)` молча отписывает первый. Музыка и TTS — одна очередь (`kind: 'track' | 'tts'`) в `VoiceSession`. Не добавлять второй плеер.
2. **Не стримить mp3 напрямую в плеер.** CDN Яндекса рвёт длинные соединения (`terminated` undici / `aborted` https). `downloadTrack()` качает файл целиком в память, затем играет; обязательно следовать 3xx (`get-mp3` отдаёт 308).
3. **Громкость через `resource.volume.setVolume`** (в 0.19 нет `volumeTransformer`). Музыка `MUSIC_VOLUME_DEFAULT = 0.20`, TTS `TTS_VOLUME_DEFAULT = 2.6`.
4. **STT — v3 gRPC-стриминг, два режима; фолбэк на v1 HTTP.** v3 — bidirectional gRPC `speechkit.stt.v3.Recognizer/RecognizeStreaming` на `stt.api.cloud.yandex.net:443`, авторизация через metadata `authorization: Api-Key <key>`, аудио raw LPCM 16-bit 48k mono. Основной путь — `createRecognizer` (`src/stt/v3.js`) с `audioProcessingType: REAL_TIME`: PCM стримится по мере поступления, `partial` приходит во время речи (по нему `listener.js` детектит wake). Не сбрасывать весь буфер разом в REAL_TIME — это путает VAD/EOU модели и режет слова. После тишины шлётся `eou` → `final` → команда. При ошибке стрима — фолбэк `recognizePcmV3` (`audioProcessingType: FULL_DATA`, накопленный буфер целиком), затем v1. gRPC-дедлайн 180с и один переиспользуемый клиент на все стримы (не создавать `new Recognizer` на каждый стрим — иначе новый TLS+LB pick на 10+ секунд съедает дедлайн). WebSocket-эндпоинты (хосты `transcribe.api.cloud.yandex.net`) отдают 403 — это v2 async REST, не использовать и не возвращать WS-код. Финальный фолбэк v1: `POST stt.api.cloud.yandex.net/speech/v1/stt:recognize?format=lpcm&...`.
5. **Поиск — через `instant/mixed`, берём первый результат.** Треки: `/search/instant/mixed?type=track` → первый трек. Плейлисты: `type=playlist` → первый плейлист → треки `/users/{uid}/playlists/{kind}`. Ранжирование целиком на API, своего скоринга нет. Кириллический запрос с 0 треков → GPT-фикс + `translitFallbacks`, переспросить instant.
6. **Ссылка на mp3 из `download-info` живёт ~1 минуту**; формула: `md5(SIGN_SALT + path.slice(1) + s)`, URL `https://{host}/get-mp3/{sign}/{ts}{path}`. Заголовок `X-Yandex-Music-Client` обязателен для download-info.
7. **Wake-слова берутся из `.env`**, если переменная задана — она переопределяет дефолт в `config.js`. При смене wake-слова проверять `.env`, а не только код.
8. **TTS v1 НЕ поддерживает `profanityFilter`** (400 unexpected field). Не добавлять этот параметр.
9. `speakText` прерывает текущий трек и ставит его обратно в очередь после озвучки — сохранять это поведение при правках очереди.
10. **Флаг `starting` в `VoiceSession` обязателен.** `start()` асинхронный (качает трек), а `player.state.status` остаётся `Idle` во время загрузки. Без `starting` `startNext()` при добавлении очереди запускает все треки разом (каждый выхватывает следующий из очереди), и 9 из 10 отбрасываются как «не Idle». `startNext()` не должен запускать новый трек, пока `start()` не завершился.
11. **Озвучка названия трека.** Когда музыка уже играет (`session.current.kind === 'track'`), добавление трека/плейлиста в очередь объявляется голосом сразу — через `speakUma`, который прерывает текущий трек и продолжает его после озвучки. Когда ничего не играет — через поле `announce`: в `start()` при его наличии и заданном `this.tts.apiKey` перед треком в очередь вставляется TTS с этим текстом, само поле удаляется (чтобы не зациклиться).
12. **Отклик на wake-слово — звуковой сигнал во время речи.** `listener.js` детектит wake в `partial` через `findWakeToken`/`isWakeToken` (`parse.js`: точное совпадение с `config.wakeWords` + явные ослышки `WAKE_VARIANTS`; без нечёткого матчинга — он даёт ложные срабатывания на коротких wake-словах) и вызывает `onWake` → `session.playChime()` (мягкий колокольчик E5→B5 с обертонами, raw-PCM, кэш в `getChimeBuffer`). Словами «Слушаю» не отвечать — отклик должен прийти до конца фразы. Ослышки менять в `WAKE_VARIANTS`, тон/длительность — в `getChimeBuffer`.
13. **Переход между каналами — через `moveSession` → `connection.rejoin({channelId})`, не через destroy.** Автопереход (`findPopulatedVoiceChannel` в `index.js`) переиспользует существующее `VoiceConnection`: `rejoin` шлёт VoiceStateUpdate на новый канал, а плеер, очередь и слушатель остаются на том же соединении — музыка не прерывается. Не заменять `moveSession` на `destroySession`+`getSession`: destroy дропает очередь и текущий трек.

## Особенности поиска (dispatch.js)

- Поиск идёт через instant/mixed (`instantSearch`, type=track) и **берётся первый трек** — ранжирование целиком на API, своего скоринга нет. Запрос предварительно чистится `cleanQuery` от филлеров.
- Если instant вернул 0 треков и в запросе есть кириллица — `instantSearchFixed`: GPT-фикс (`fixUtterance`) + `translitFallbacks`, кандидаты по очереди переспрашивают instant, берётся первый непустой результат. Кириллическая транскрипция английского («еверифинк блек») превращается в точную латиницу («everything black»).
- Плейлист: ключевое слово «плейлист» (`isPlaylistIntent`) → `instantPlaylists` (type=playlist) → первый плейлист → `playlistTracks` → треки в очередь.
- instant/mixed почти строгий: транслит без GPT не матчит (`everifink black` → 0 треков) — нужна точная латиница из GPT. Русские запросы находят сразу, GPT не зовётся.
- Смешанные запросы («poli сестра») — известная слабость: непонятно, какой язык/написание нужно. Улучшения приветствуются, но проверяй на реальном API.

## «Просто музыка» (волна)

- Триггеры в `parse.js` (`isWaveIntent`): «включи музыку», «включи что-нибудь», «включи популярное», «хиты», «чарт» и т.п. — запрос без конкретного названия → `__wave__`.
- `playWave` (`dispatch.js`) тянет `/landing3/chart` (топ-чарт «популярное прямо сейчас»), тасует топ-100 и кладёт в очередь. Играет **бесконечно**: когда очередь пустеет, `VoiceSession` вызывает `waveRefill` (колбэк из `playWave`), который догружает чарт заново. Остановка — «стоп» (`stopPlaying` сбрасывает `waveRefill`).
- Конкретный трек («включи X») во время волны ставится следующим после текущего (`playNext` — в начало очереди, с ленивой ссылкой) и не сбрасывает волну: после него очередь хитов продолжается с того же места.
- **«Моя волна» — отдельная персональная радиостанция**, не топ-чарт. Триггер `isMyWaveIntent` (`parse.js`: «моя волна»/«мою волну»/«моей волны») → `__mywave__` → `playMyWave` (`dispatch.js`). Источник — `/rotor/station/user:onyourwave/tracks` (`client.myWaveTracks()`), ~5 треков за запрос. Повторы фильтруются по `id` через `Set` (`played` в замыкании `playMyWave`), `MY_WAVE_BATCHES = 4` запроса на догрузку. Рефилл через тот же `waveRefill`.
- **Ссылки на mp3 резолвятся лениво**: в очередь кладётся `url: () => music.playableUrl(id)` (функция), а не готовый URL — ссылка из `download-info` живёт ~1 мин, качать все 100 сразу нельзя. `trackResource` в `session.js` вызывает функцию в момент проигрывания.

## Логи и отладка

Ключевые строки: `Услышала (id)`, `Голос -> команда`, `Ответ: "..."`, `Поиск instant «...»: треков N`, `Поиск instant кандидат «...»`, `Поиск instant плейлистов «...»`, `Плейлист «...»: N треков`, `Выбран трек`, `[player]`, `[voice]`.

Probe-интервал в `VoiceSession` закомментирован — при отладке звука можно временно включить.

## TODO / известные слабости

- Кэш скачанных mp3 (сейчас каждый раз качается заново).
- «Смешанный язык» запросов (латиница + кириллица в одном названии).
- Убрать `debug: true` из `voice/connection.js` перед продакшеном.
- Нет тестов; при добавлении — Vitest/Jest не настроены, выбирать осознанно.

## Git

- Только по явной просьбе: не коммитить, не пушить.
- `.env`, `node_modules`, временные файлы (`tmp.ogg`, `tmp.pcm`) не должны попадать в git. Случайный файл `nul` (артефакт Windows-редиректа) удалять.
- Перед коммитом: `git status`, `git diff`, прогнать `node --check` по изменённым файлам.
