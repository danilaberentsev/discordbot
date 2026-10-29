import 'dotenv/config';

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  guildId: process.env.GUILD_ID ?? '',
  cloudApiKey: process.env.YANDEX_CLOUD_API_KEY ?? '',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  yandexMusicToken: process.env.YANDEX_MUSIC_TOKEN ?? '',
  sttLanguage: process.env.STT_LANGUAGE ?? 'ru-RU',
  sttSampleRate: 48000,
  ttsVoice: process.env.TTS_VOICE ?? 'alena',
  followupEnabled: process.env.FOLLOWUP_ENABLED === 'true',
  wakeWords: (process.env.WAKE_WORDS ?? 'маруся,marusya,марусь,руся,русь')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean),
};

if (!config.discordToken) {
  console.warn('DISCORD_TOKEN не задан, бот не запустится');
}
