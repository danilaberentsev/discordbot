import { fixUtterance } from '../assistant/llm.js';
import { translitFallbacks } from './translit.js';
import { cleanQuery, isWaveIntent, isPlaylistIntent, stripPlaylistWord } from './parse.js';
import { config } from '../config.js';

const WAVE_CHART_LIMIT = 100;

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
      return 'Переключаю трек';
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
  const wave = !query || query === '__wave__' || query.includes('моя волна') || isWaveIntent(cleanQuery(query));
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
    session.playTrack({ id: track.id, title: track.title, artists: track.artists, url: () => music.playableUrl(track.id) });
  }
  return chart.length;
}

async function playWave(session, music) {
  const refill = async () => {
    try {
      await enqueueChart(session, music);
    } catch (err) {
      console.error('Волна: не удалось догрузить чарт:', err.message);
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

async function startPicked(session, music, candidate) {
  const label = candidate.picked.artists ? `${candidate.picked.artists} — ${candidate.picked.title}` : candidate.picked.title;
  const announce = candidate.picked.artists
    ? `Включаю: ${candidate.picked.artists}, ${candidate.picked.title}`
    : `Включаю: ${candidate.picked.title}`;
  if (session.waveRefill) {
    session.playNext({
      id: candidate.picked.id,
      title: candidate.picked.title,
      artists: candidate.picked.artists,
      announce,
      url: () => music.playableUrl(candidate.picked.id),
    });
  } else {
    const url = await music.playableUrl(candidate.picked.id);
    await session.playTrack({ id: candidate.picked.id, title: candidate.picked.title, artists: candidate.picked.artists, announce, url });
  }
  console.log(`Выбран трек: ${label} (id ${candidate.picked.id})`);
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
  return startPicked(session, music, { query, picked, score: 0 });
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
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const item = { id: t.id, title: t.title, artists: t.artists, url: () => music.playableUrl(t.id) };
    if (i === 0) item.announce = `Включаю плейлист: ${pl.title}`;
    session.playTrack(item);
  }
  return `Включаю плейлист: ${pl.title}`;
}
