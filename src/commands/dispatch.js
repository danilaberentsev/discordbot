const WAVE_QUERY = 'главные хиты';

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

export async function playMusic(session, music, query) {
  if (!music) throw new Error('YANDEX_MUSIC_TOKEN не настроен');
  const wave = !query || query === '__wave__' || query.includes('моя волна');
  const actualQuery = wave ? WAVE_QUERY : query;

  let searchQuery = actualQuery;
  let { best, tracks } = await music.searchAll(searchQuery);
  console.log(`Поиск «${searchQuery}»: треков ${tracks.length}, best ${best ? best.type : 'null'}`);
  let tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  while (!tracks.length && !best && tokens.length > 1) {
    tokens.pop();
    searchQuery = tokens.join(' ');
    ({ best, tracks } = await music.searchAll(searchQuery));
    console.log(`Поиск с урезанным запросом «${searchQuery}»: треков ${tracks.length}`);
  }
  if (!tracks.length && !best) return `Ничего не нашла по запросу ${actualQuery}`;

  let picked;
  if (!wave && best?.type === 'track' && best.result) {
    picked = music.normalizeTrack(best.result);
    console.log('Взят best-трек из поиска');
  } else if (!wave && best?.type === 'album' && best.result?.id) {
    const album = await music.albumTracks(best.result.id);
    console.log(`Взят трек из best-альбома «${best.result.title}» (${album.length} треков)`);
    picked = album[0];
  } else {
    tracks = tracks.map((t) => music.normalizeTrack(t));
    picked = wave
      ? tracks[Math.floor(Math.random() * tracks.length)]
      : [...tracks].sort((a, b) => scoreTrack(b, tokens, searchQuery) - scoreTrack(a, tokens, searchQuery))[0];
  }

  const url = await music.playableUrl(picked.id);
  await session.playTrack({ title: picked.title, artists: picked.artists, url });
  const label = picked.artists ? `${picked.artists} — ${picked.title}` : picked.title;
  console.log(`Выбран трек: ${label} (id ${picked.id})`);
  return `Включаю: ${label}`;
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
