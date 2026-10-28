import { fixUtterance } from '../assistant/llm.js';
import { translitFallbacks } from './translit.js';
import { cleanQuery, isWaveIntent, isPlaylistIntent, stripPlaylistWord, isMyWaveIntent } from './parse.js';
import { config } from '../config.js';
import { speakUma } from '../tts/synthesize.js';

const WAVE_CHART_LIMIT = 100;

function trackItem(track, music) {
  return { id: track.id, title: track.title, artists: track.artists, url: () => music.playableUrl(track.id) };
}

function defaultFixer(query) {
  if (config.cloudApiKey && config.yandexGptFolderId) {
    return fixUtterance(query, {
      apiKey: config.cloudApiKey,
      folderId: config.yandexGptFolderId,
    });
  }
  return query;
}

export async function runMusicCommand(session, music, cmd) {
  switch (cmd.action) {
    case 'stop':
      session.stopPlaying();
      return 'Остановила музыку';
    case 'skip':
      if (!session.current) return 'Сейчас ничего не играет';
      session.skip();
      // без голосового объявления: озвучка прерывает уже начавшуюся загрузку
      // следующего трека и скипает его (теряется один трек из очереди)
      return null;
    case 'volume': {
      const volume = cmd.level !== undefined
        ? session.setVolume(cmd.level)
        : session.changeVolume(cmd.delta);
      return `Громкость: ${Math.round(volume * 100)}%`;
    }
    case 'play':
      return playMusic(session, music, cmd.query);
    default:
      return null;
  }
}

export async function playMusic(session, music, query, fixer = defaultFixer) {
  if (!music) throw new Error('YANDEX_MUSIC_TOKEN не настроен');
  if (query === '__mywave__' || isMyWaveIntent(query)) return playMyWave(session, music);
  const wave = !query || query === '__wave__' || isWaveIntent(cleanQuery(query));
  if (wave) return playWave(session, music);

  const actualQuery = cleanQuery(query);
  if (isPlaylistIntent(actualQuery)) return playInstantPlaylist(session, music, stripPlaylistWord(actualQuery));
  return playInstant(session, music, actualQuery, fixer);
}

function shuffle(items) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

async function enqueueChart(session, music) {
  const chart = await music.chart(WAVE_CHART_LIMIT);
  if (!chart.length) return 0;
  for (const track of shuffle(chart)) {
    session.playTrack(trackItem(track, music));
  }
  return chart.length;
}

async function playWave(session, music) {
  const refill = async () => {
    let count = 0;
    try {
      count = await enqueueChart(session, music);
    } catch (err) {
      console.error('Волна: не удалось догрузить чарт:', err.message);
    }
    if (!count) {
      session.setWaveRefill(null);
      session.onIdle?.();
    }
  };
  let count;
  try {
    count = await enqueueChart(session, music);
  } catch (err) {
    console.error('Волна:', err.message);
    return `Не получилось: ${err.message}`;
  }
  if (!count) return 'Ничего не нашла в чарте';
  session.setWaveRefill(refill);
  console.log(`Волна: ${count} треков в очереди`);
  return 'Включаю: популярные треки';
}

const MY_WAVE_BATCHES = 4;

// «Моя волна» — персональная радиостанция: дёргаем несколько раз, фильтруем повторы по id
async function enqueueMyWave(session, music, played) {
  let added = 0;
  for (let i = 0; i < MY_WAVE_BATCHES; i++) {
    const tracks = await music.myWaveTracks();
    const fresh = tracks.filter((t) => !played.has(t.id));
    if (!fresh.length) break;
    for (const t of fresh) {
      played.add(t.id);
      session.playTrack(trackItem(t, music));
      added++;
    }
  }
  return added;
}

async function playMyWave(session, music) {
  const played = new Set();
  const refill = async () => {
    let count = 0;
    try {
      count = await enqueueMyWave(session, music, played);
    } catch (err) {
      console.error('Моя волна: не удалось догрузить:', err.message);
    }
    if (!count) {
      session.setWaveRefill(null);
      session.onIdle?.();
    }
  };
  let count;
  try {
    count = await enqueueMyWave(session, music, played);
  } catch (err) {
    console.error('Моя волна:', err.message);
    return `Не получилось: ${err.message}`;
  }
  if (!count) return 'Не смогла включить мою волну';
  session.setWaveRefill(refill);
  console.log(`Моя волна: ${count} треков в очереди`);
  return 'Включаю мою волну';
}

async function startPicked(session, music, picked) {
  const label = picked.artists ? `${picked.artists} — ${picked.title}` : picked.title;
  const item = trackItem(picked, music);
  if (session.current?.kind === 'track') {
    // музыка уже играет — добавляем в очередь и объявляем сразу (с прерыванием)
    const announce = picked.artists
      ? `Добавляю ${picked.artists}, ${picked.title} следующим`
      : `Добавляю ${picked.title} следующим`;
    if (session.waveRefill) session.playNext(item);
    else await session.playTrack(item);
    await speakUma(session, announce);
  } else {
    // ничего не играет — announce сыграет прямо перед треком
    const announce = picked.artists
      ? `Включаю: ${picked.artists}, ${picked.title}`
      : `Включаю: ${picked.title}`;
    item.announce = announce;
    if (session.waveRefill) session.playNext(item);
    else await session.playTrack(item);
  }
  console.log(`Выбран трек: ${label} (id ${picked.id})`);
  return `Включаю: ${label}`;
}

async function playInstant(session, music, query, fixer) {
  let tracks = await music.instantSearch(query);
  console.log(`Поиск instant «${query}»: треков ${tracks.length}`);
  if (!tracks.length && /[а-яё]/i.test(query)) {
    tracks = await instantSearchFixed(music, query, fixer);
  }
  const picked = tracks[0];
  if (!picked) return `Ничего не нашла по запросу ${query}`;
  return startPicked(session, music, picked);
}

async function instantSearchFixed(music, query, fixer) {
  const candidates = new Set();
  if (fixer) {
    try {
      const fixed = await fixer(query);
      if (fixed && cleanQuery(fixed) !== query.toLowerCase()) candidates.add(fixed);
    } catch (err) {
      console.log('Фикс запроса не удался:', err.message);
    }
  }
  for (const candidate of translitFallbacks(query)) candidates.add(candidate);
  for (const candidate of candidates) {
    const tracks = await music.instantSearch(candidate);
    console.log(`Поиск instant кандидат «${candidate}»: треков ${tracks.length}`);
    if (tracks.length) return tracks;
  }
  return [];
}

async function playInstantPlaylist(session, music, query) {
  const playlists = await music.instantPlaylists(query);
  console.log(`Поиск instant плейлистов «${query}»: ${playlists.length}`);
  const pl = playlists[0];
  if (!pl) return `Не нашла плейлист по запросу ${query}`;
  const tracks = await music.playlistTracks(pl.uid, pl.kind);
  console.log(`Плейлист «${pl.title}»: ${tracks.length} треков`);
  if (!tracks.length) return `Плейлист «${pl.title}» пустой`;
  const playing = session.current?.kind === 'track';
  const announce = playing
    ? `Добавляю плейлист ${pl.title} следующим`
    : `Включаю плейлист: ${pl.title}`;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const item = trackItem(t, music);
    if (i === 0 && !playing) item.announce = announce;
    session.playTrack(item);
  }
  if (playing) await speakUma(session, announce);
  return `Включаю плейлист: ${pl.title}`;
}
