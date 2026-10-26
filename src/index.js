import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
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
const LISTEN_WINDOW_MS = 8000;

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Позвать Аделину в голосовой канал'),
  new SlashCommandBuilder().setName('leave').setDescription('Выгнать Аделину из канала'),
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

function getSession(guild, channel, textChannelId) {
  const existing = sessions.get(guild.id);
  if (existing) {
    if (textChannelId) existing.textChannelId = textChannelId;
    if (existing.connection.joinConfig.channelId !== channel.id) {
      destroySession(guild.id);
    } else {
      return existing;
    }
  }

  const connection = connectToChannel(channel);
  const session = new VoiceSession(connection, { apiKey: config.cloudApiKey, voice: config.ttsVoice });
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

  const record = {
    guildId: guild.id,
    connection,
    session,
    listener,
    music,
    listeningUntil: 0,
    textChannelId: textChannelId ?? null,
    nowPlayingMessage: null,
  };
  sessions.set(guild.id, record);
  session.onTrackStart = () => updateNowPlaying(record);
  session.onIdle = () => updateNowPlaying(record);
  return record;
}

function destroySession(guildId) {
  const record = sessions.get(guildId);
  if (!record) return;
  sessions.delete(guildId);
  try {
    record.session.destroy();
  } catch (err) {
    console.error('session.destroy:', err.message);
  }
  try {
    record.listener.stop();
  } catch (err) {
    console.error('listener.stop:', err.message);
  }
  try {
    record.connection.destroy();
  } catch (err) {
    console.error('connection.destroy:', err.message);
  }
  record.nowPlayingMessage?.delete().catch(() => {});
}

function buildNowPlayingContent(record) {
  const { session } = record;
  const current = session.current;
  const status = session.player.state.status;

  let description;
  let color;
  if (current?.kind === 'track') {
    const label = current.artists ? `${current.artists} — ${current.title}` : current.title;
    if (status === AudioPlayerStatus.Paused) {
      description = `⏸ Пауза: ${label}`;
      color = 0xf1c40f;
    } else {
      description = `▶ Играет: ${label}`;
      color = 0x2ecc71;
    }
  } else {
    description = '⏹ Ничего не играет';
    color = 0x95a5a6;
  }

  const embed = new EmbedBuilder().setTitle('Плеер').setDescription(description).setColor(color);
  const toggle = status === AudioPlayerStatus.Paused
    ? new ButtonBuilder().setCustomId('np:resume').setLabel('▶ Продолжить').setStyle(ButtonStyle.Primary)
    : new ButtonBuilder().setCustomId('np:pause').setLabel('⏸ Пауза').setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('np:stop').setLabel('⏹ Стоп').setStyle(ButtonStyle.Danger),
    toggle,
    new ButtonBuilder().setCustomId('np:next').setLabel('⏭ Следующая').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function updateNowPlaying(record) {
  if (sessions.get(record.guildId) !== record) return;
  if (!record.textChannelId) return;
  const channel = client.channels.cache.get(record.textChannelId);
  if (!channel) return;
  const content = buildNowPlayingContent(record);
  try {
    if (record.nowPlayingMessage) {
      await record.nowPlayingMessage.edit(content);
    } else {
      record.nowPlayingMessage = await channel.send(content);
    }
  } catch (err) {
    record.nowPlayingMessage = null;
  }
}

async function handleNowPlayingButton(interaction) {
  if (!interaction.customId.startsWith('np:')) return;
  const action = interaction.customId.slice(3);
  const record = sessions.get(interaction.guildId);
  if (!record) {
    await interaction.reply({ content: 'Нет активной сессии', ephemeral: true }).catch(() => {});
    return;
  }

  switch (action) {
    case 'stop':
      record.session.stopPlaying();
      await interaction.deferUpdate().catch(() => {});
      return;
    case 'next':
      record.session.skip();
      await interaction.deferUpdate().catch(() => {});
      return;
    case 'pause':
      record.session.pause();
      break;
    case 'resume':
      record.session.unpause();
      break;
    default:
      return;
  }
  await interaction.update(buildNowPlayingContent(record)).catch(() => {});
}

async function handleUtterance(guildId, text, userId) {
  const record = sessions.get(guildId);
  if (!record) return;
  const { matched, rest } = stripWake(text);

  if (matched) {
    console.log(`Голос -> команда: "${rest}" (было: "${text}")`);
    if (rest) {
      record.listeningUntil = 0;
      await runCommand(record, rest, userId);
    } else {
      record.listeningUntil = Date.now() + LISTEN_WINDOW_MS;
      await speakUma(record.session, 'Слушаю');
    }
    return;
  }

  if (record.listeningUntil && Date.now() < record.listeningUntil) {
    console.log(`Голос -> команда (без wake): "${text}"`);
    if (await runCommand(record, text, userId)) {
      record.listeningUntil = 0;
    }
  }
}

async function runCommand(record, text, userId) {
  const cmd = parseCommand(text);
  if (!cmd) return false;

  if (cmd.action === 'leave') {
    destroySession(record.connection.joinConfig.guildId);
    return true;
  }

  if (cmd.action === 'assistant') {
    if (!assistant) {
      console.log('Ассистент не настроен, нужен YANDEX_CLOUD_API_KEY и YANDEXGPT_FOLDER_ID');
      await speakUma(record.session, 'Ассистент пока не настроен');
      return true;
    }
    try {
      const answer = await assistant.ask(userId, cmd.text);
      if (answer) await speakUma(record.session, answer);
    } catch (err) {
      console.error('Ассистент:', err.message);
      await speakUma(record.session, 'Что-то я тебе не поняла, попробуй ещё раз');
    }
    return true;
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
  return true;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    await handleNowPlayingButton(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const voiceChannel = interaction.member?.voice?.channel ?? null;

  try {
    switch (interaction.commandName) {
      case 'join': {
        if (!voiceChannel) {
          await interaction.reply({ content: 'Зайди в голосовой канал, потом зови', ephemeral: true });
          return;
        }
        getSession(interaction.guild, voiceChannel, interaction.channelId);
        await interaction.reply(`Села в «${voiceChannel.name}».`);
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
        const record = getSession(interaction.guild, voiceChannel, interaction.channelId);
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
