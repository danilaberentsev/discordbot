import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import { connectToChannel } from './voice/connection.js';
import { VoiceSession } from './voice/session.js';
import { VoiceListener } from './listen/listener.js';
import { YandexMusicClient } from './music/client.js';
import { stripWake, parseCommand } from './commands/parse.js';
import { runMusicCommand, playMusic } from './commands/dispatch.js';
import { Assistant } from './assistant/context.js';
import { speakUma } from './tts/synthesize.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sessions = new Map();
const assistant = config.cloudApiKey && config.yandexGptFolderId
  ? new Assistant({ apiKey: config.cloudApiKey, folderId: config.yandexGptFolderId })
  : null;

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Позвать Алису в голосовой канал'),
  new SlashCommandBuilder().setName('leave').setDescription('Выгнать Алису из канала'),
  new SlashCommandBuilder().setName('play')
    .setDescription('Включить трек по поиску')
    .addStringOption((option) => option
      .setName('query')
      .setDescription('Что искать в Яндекс Музыке')
      .setRequired(true)),
  new SlashCommandBuilder().setName('stop').setDescription('Остановить музыку'),
].map((command) => command.toJSON());

client.once(Events.ClientReady, async (ready) => {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const body = { body: commands };
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(ready.application.id, config.guildId), body);
  } else {
    await rest.put(Routes.applicationCommands(ready.application.id), body);
  }
  console.log(`Готова: ${ready.user.tag}`);
});

function getSession(guild, channel) {
  const existing = sessions.get(guild.id);
  if (existing) {
    if (existing.connection.joinConfig.channelId !== channel.id) {
      destroySession(guild.id);
    } else {
      return existing;
    }
  }

  const connection = connectToChannel(channel);
  const session = new VoiceSession(connection);
  const listener = new VoiceListener(connection, client.user.id, {
    apiKey: config.cloudApiKey,
    language: config.sttLanguage,
    sampleRate: config.sttSampleRate,
    onUtterance: (text, userId) => {
      handleUtterance(guild.id, text, userId).catch((err) => console.error(err));
    },
  });
  listener.start();
  const music = config.yandexMusicToken ? new YandexMusicClient(config.yandexMusicToken) : null;

  const record = { connection, session, listener, music };
  sessions.set(guild.id, record);
  return record;
}

function destroySession(guildId) {
  const record = sessions.get(guildId);
  if (!record) return;
  record.listener.stop();
  record.connection.destroy();
  sessions.delete(guildId);
}

async function handleUtterance(guildId, text, userId) {
  const record = sessions.get(guildId);
  if (!record) return;
  const { matched, rest } = stripWake(text);
  if (!matched) return;
  console.log(`Голос -> команда: "${rest}" (было: "${text}")`);

  if (!rest) {
    await speakUma(record.session, 'Да?');
    return;
  }

  const cmd = parseCommand(rest);
  if (!cmd) return;

  if (cmd.action === 'assistant') {
    if (!assistant) {
      console.log('Ассистент не настроен, нужен YANDEX_CLOUD_API_KEY и YANDEXGPT_FOLDER_ID');
      await speakUma(record.session, 'Ассистент пока не настроен');
      return;
    }
    try {
      const answer = await assistant.ask(userId, cmd.text);
      if (answer) await speakUma(record.session, answer);
    } catch (err) {
      console.error('Ассистент:', err.message);
      await speakUma(record.session, 'Что-то я тебе не поняла, попробуй ещё раз');
    }
    return;
  }

  try {
    const reply = await runMusicCommand(record.session, record.music, cmd);
    if (reply && !reply.startsWith('Включаю')) {
      await speakUma(record.session, reply);
    }
  } catch (err) {
    console.error('Команда:', err.message);
    await speakUma(record.session, `Не получилось: ${err.message}`);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const voiceChannel = interaction.member?.voice?.channel ?? null;

  try {
    switch (interaction.commandName) {
      case 'join': {
        if (!voiceChannel) {
          await interaction.reply({ content: 'Зайди в голосовой канал, потом зови', ephemeral: true });
          return;
        }
        getSession(interaction.guild, voiceChannel);
        await interaction.reply(`Села в «${voiceChannel.name}». Скажи «Алиса, включи...» или задай вопрос`);
        break;
      }
      case 'leave': {
        destroySession(interaction.guild.id);
        await interaction.reply('Всё, я пошла');
        break;
      }
      case 'stop': {
        sessions.get(interaction.guild.id)?.session.stopPlaying();
        await interaction.reply('Остановила музыку');
        break;
      }
      case 'play': {
        if (!voiceChannel) {
          await interaction.reply({ content: 'Сначала зайди в голосовой канал', ephemeral: true });
          return;
        }
        const record = getSession(interaction.guild, voiceChannel);
        await interaction.deferReply();
        const query = interaction.options.getString('query', true);
        const result = await playMusic(record.session, record.music, query);
        await interaction.editReply(result);
        break;
      }
      default:
        await interaction.reply({ content: 'Не знаю такой команды', ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    const message = `Ошибка: ${err.message}`;
    if (interaction.deferred) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState?.guild?.id ?? newState?.guild?.id;
  if (!guildId) return;
  const record = sessions.get(guildId);
  if (!record) return;
  if (newState.member?.user?.bot) return;

  const botChannelId = record.connection.joinConfig.channelId;
  if (oldState.channelId !== botChannelId || newState.channelId === botChannelId) return;

  setTimeout(() => {
    const channel = oldState.guild.channels.cache.get(botChannelId);
    const humans = channel?.members?.filter((member) => !member.user.bot).size ?? 0;
    if (humans === 0) destroySession(guildId);
  }, 2000);
});

if (!config.discordToken) {
  console.error('Нет DISCORD_TOKEN в .env');
  process.exit(1);
}

client.login(config.discordToken).catch((err) => {
  console.error('Не удалось войти в Discord:', err.message);
  process.exit(1);
});
