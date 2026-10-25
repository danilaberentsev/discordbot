import { fixUtterance } from '../assistant/llm.js';
import { translitFallbacks } from './translit.js';
import { cleanQuery, isWaveIntent } from './parse.js';
import { scoreTrack, tokenize } from './score.js';

const CANDIDATE_SCORE_THRESHOLD = 30;
const LIKES_WEIGHT = 5;
const WAVE_CHART_LIMIT = 100;

function defaultFixer(query) {
  if (process.env.YANDEX_CLOUD_API_KEY && process.env.YANDEXGPT_FOLDER_ID) {
    return fixUtterance(query, {
      apiKey: process.env.YANDEX_CLOUD_API_KEY,
      folderId: process.env.YANDEXGPT_FOLDER_ID,
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
      const volume = session.changeVolume(cmd.delta);
      return volume < 0.3 ? 'Сделала тише' : 'Сделала громче';
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
  const primary = await pickTrack(music, actualQuery);

  if ((!primary || primary.score < CANDIDATE_SCORE_THRESHOLD) && /[a-zа-яё]/i.test(actualQuery)) {
    const candidateQueries = new Set();
    if (fixer) {
      try {
        const fixed = await fixer(actualQuery);
        if (fixed && cleanQuery(fixed) !== actualQuery.toLowerCase()) candidateQueries.add(fixed);
      } catch (err) {
        console.log('Фикс запроса не удался:', err.message);
      }
    }
    for (const candidate of translitFallbacks(actualQuery)) candidateQueries.add(candidate);

    const alts = primary ? [primary] : [];
    const settled = await Promise.allSettled([...candidateQueries].map((c) => pickTrack(music, c)));
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) alts.push(result.value);
    }
    if (!alts.length) return `Ничего не нашла по запросу ${actualQuery}`;

    const likesCache = new Map();
    await Promise.all(alts.map(async (alt) => {
      const likes = await albumLikes(music, alt.picked.albumId, likesCache);
      alt.rank = alt.score + Math.log10((likes ?? 0) + 1) * LIKES_WEIGHT;
      console.log(`Кандидат «${alt.query}»: score=${alt.score}, лайков=${likes ?? '?'} -> ${alt.picked.artists} — ${alt.picked.title}`);
    }));
    const winner = alts.reduce((best, alt) => (alt.rank > best.rank ? alt : best));
    return startPicked(session, music, winner);
  }
  return startPicked(session, music, primary);
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
    session.playTrack({ title: track.title, artists: track.artists, url: () => music.playableUrl(track.id) });
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

async function albumLikes(music, albumId, cache) {
  if (!albumId || cache.has(albumId)) return cache.get(albumId) ?? null;
  try {
    const data = await music.request(`/albums/${albumId}`);
    const likes = data?.result?.likesCount ?? null;
    cache.set(albumId, likes);
    return likes;
  } catch {
    cache.set(albumId, null);
    return null;
  }
}

async function startPicked(session, music, candidate) {
  const label = candidate.picked.artists ? `${candidate.picked.artists} — ${candidate.picked.title}` : candidate.picked.title;
  if (session.waveRefill) {
    session.playNext({
      title: candidate.picked.title,
      artists: candidate.picked.artists,
      url: () => music.playableUrl(candidate.picked.id),
    });
  } else {
    const url = await music.playableUrl(candidate.picked.id);
    await session.playTrack({ title: candidate.picked.title, artists: candidate.picked.artists, url });
  }
  console.log(`Выбран трек: ${label} (id ${candidate.picked.id})`);
  return `Включаю: ${label}`;
}

async function pickTrack(music, query) {
  let searchQuery = query;
  let { best, tracks } = await music.searchAll(searchQuery);
  console.log(`Поиск «${searchQuery}»: треков ${tracks.length}, best ${best ? best.type : 'null'}`);
  const tokens = tokenize(searchQuery);
  while (!tracks.length && !best && tokens.length > 1) {
    tokens.pop();
    searchQuery = tokens.join(' ');
    ({ best, tracks } = await music.searchAll(searchQuery));
    console.log(`Поиск с урезанным запросом «${searchQuery}»: треков ${tracks.length}`);
  }
  if (!tracks.length && !best) return null;

  let picked;
  if (best?.type === 'album' && best.result?.id) {
    const album = await music.albumTracks(best.result.id);
    console.log(`Взят best-альбом «${best.result.title}» (${album.length} треков)`);
    const scored = album.map((t) => ({ t, s: scoreTrack(t, query) }));
    scored.sort((a, b) => b.s - a.s);
    picked = scored.length && scored[0].s > 0 ? scored[0].t : album[0];
  } else if (best?.type === 'track' && best.result) {
    const bestTrack = music.normalizeTrack(best.result);
    const topFromList = tracks.length
      ? [...tracks].sort((a, b) => scoreTrack(b, query) - scoreTrack(a, query))[0]
      : null;
    const bestScore = scoreTrack(bestTrack, query);
    const listScore = topFromList ? scoreTrack(topFromList, query) : -1;
    picked = listScore > bestScore ? topFromList : bestTrack;
  } else if (tracks.length) {
    picked = [...tracks].sort((a, b) => scoreTrack(b, query) - scoreTrack(a, query))[0];
  } else {
    return null;
  }

  if (!picked) return null;
  const score = scoreTrack(picked, query);
  return { query, picked, score };
}
