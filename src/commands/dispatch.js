const WAVE_QUERY = 'главные хиты';
import { fixUtterance } from '../assistant/llm.js';
import { translitFallbacks } from './translit.js';

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
  const wave = !query || query === '__wave__' || query.includes('моя волна');
  const actualQuery = wave ? WAVE_QUERY : query;

  const primary = await pickTrack(music, actualQuery, wave);
  if (wave && !primary) return `Ничего не нашла для «${actualQuery}»`;

  if (!wave && (!primary || primary.score < 20) && /[a-zа-яё]/i.test(actualQuery)) {
    const candidateQueries = [];
    if (fixer) {
      try {
        const fixed = await fixer(actualQuery);
        if (fixed && fixed.toLowerCase() !== actualQuery.toLowerCase()) candidateQueries.push(fixed);
      } catch (err) {
        console.log('Фикс запроса не удался:', err.message);
      }
    }
    candidateQueries.push(...translitFallbacks(actualQuery));

    const alts = primary ? [primary] : [];
    for (const candidateQuery of candidateQueries) {
      const alt = await pickTrack(music, candidateQuery, false);
      if (alt) alts.push(alt);
    }
    if (!alts.length) return `Ничего не нашла по запросу ${actualQuery}`;

    const likesCache = new Map();
    for (const alt of alts) {
      const likes = await albumLikes(music, alt.picked.albumId, likesCache);
      alt.rank = (likes ?? 0) + alt.score * 0.3;
      console.log(`Кандидат «${alt.query}»: score=${alt.score}, лайков=${likes ?? '?'} -> ${alt.picked.artists} — ${alt.picked.title}`);
    }
    const winner = alts.reduce((best, alt) => (alt.rank > best.rank ? alt : best), primary ?? alts[0]);
    return startPicked(session, music, winner);
  }
  return startPicked(session, music, primary);
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
  const url = await music.playableUrl(candidate.picked.id);
  await session.playTrack({ title: candidate.picked.title, artists: candidate.picked.artists, url });
  const label = candidate.picked.artists ? `${candidate.picked.artists} — ${candidate.picked.title}` : candidate.picked.title;
  console.log(`Выбран трек: ${label} (id ${candidate.picked.id})`);
  return `Включаю: ${label}`;
}

async function pickTrack(music, query, wave) {
  let searchQuery = query;
  let { best, tracks } = await music.searchAll(searchQuery);
  console.log(`Поиск «${searchQuery}»: треков ${tracks.length}, best ${best ? best.type : 'null'}`);
  let tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  while (!tracks.length && !best && tokens.length > 1) {
    tokens.pop();
    searchQuery = tokens.join(' ');
    ({ best, tracks } = await music.searchAll(searchQuery));
    console.log(`Поиск с урезанным запросом «${searchQuery}»: треков ${tracks.length}`);
  }
  if (!tracks.length && !best) return null;
  tracks = tracks.map((t) => music.normalizeTrack(t));

  let picked;
  if (!wave && best?.type === 'track' && best.result) {
    picked = music.normalizeTrack(best.result);
  } else if (!wave && best?.type === 'album' && best.result?.id) {
    const album = await music.albumTracks(best.result.id);
    console.log(`Взят трек из best-альбома «${best.result.title}» (${album.length} треков)`);
    picked = album[0];
  } else if (wave) {
    picked = tracks[Math.floor(Math.random() * tracks.length)];
  } else if (tracks.length) {
    picked = [...tracks].sort((a, b) => scoreTrack(b, tokens, searchQuery) - scoreTrack(a, tokens, searchQuery))[0];
  } else {
    return null;
  }
  if (!picked) return null;
  const score = wave ? 100 : scoreTrack(picked, tokens, searchQuery);
  return { query, picked, score };
}

function scoreTrack(track, tokens, query) {
  const hay = `${track.artists} ${track.title}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += 10;
  }
  const title = track.title.toLowerCase();
  if (hay.includes(query.toLowerCase())) score += 20;
  if (title === query.toLowerCase()) score += 30;
  return score;
}
