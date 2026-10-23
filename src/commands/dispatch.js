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
  const tracks = await music.searchTracks(wave ? WAVE_QUERY : query);
  console.log(`Поиск «${wave ? WAVE_QUERY : query}»: найдено ${tracks.length}`);
  if (!tracks.length) return `Ничего не нашла по запросу ${query}`;
  const track = wave
    ? tracks[Math.floor(Math.random() * tracks.length)]
    : tracks[0];
  const url = await music.playableUrl(track.id);
  await session.playTrack({ title: track.title, artists: track.artists, url });
  const label = track.artists ? `${track.artists} — ${track.title}` : track.title;
  return `Включаю: ${label}`;
}
