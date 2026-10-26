import 'dotenv/config';

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  guildId: process.env.GUILD_ID ?? '',
  cloudApiKey: process.env.YANDEX_CLOUD_API_KEY ?? '',
  yandexGptFolderId: process.env.YANDEXGPT_FOLDER_ID ?? '',
  yandexMusicToken: process.env.YANDEX_MUSIC_TOKEN ?? '',
  sttLanguage: process.env.STT_LANGUAGE ?? 'ru-RU',
  sttSampleRate: 48000,
  ttsVoice: process.env.TTS_VOICE ?? 'alena',
  autojoinUserId: process.env.AUTOJOIN_USER_ID ?? '',
  followupEnabled: process.env.FOLLOWUP_ENABLED === 'true',
  wakeWords: (process.env.WAKE_WORDS ?? 'аделина,adelina,аделинка,аделя,адель')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean),
};

if (!config.discordToken) {
  console.warn('DISCORD_TOKEN не задан, бот не запустится');
}
