import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
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
const assistant = config.deepseekApiKey
  ? new Assistant({ apiKey: config.deepseekApiKey })
  : null;
const LISTEN_WINDOW_MS = 8000;
const FOLLOWUP_WINDOW_MS = 3000;
const JOIN_GREETING = 'Всем привет!';

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Позвать Марусю в голосовой канал'),
  new SlashCommandBuilder().setName('leave').setDescription('Выгнать Марусю из канала'),
  new SlashCommandBuilder().setName('play')
    .setDescription('Включить трек по поиску')
    .addStringOption((option) => option
      .setName('query')
      .setDescription('Что искать в Яндекс Музыке')
      .setRequired(true)),
  new SlashCommandBuilder().setName('stop').setDescription('Остановить музыку'),
  new SlashCommandBuilder().setName('volume')
    .setDescription('Громкость музыки')
    .addIntegerOption((option) => option
      .setName('level')
      .setDescription('Уровень в процентах (5–100)')
      .setRequired(true)
      .setMinValue(5)
      .setMaxValue(100)),
  new SlashCommandBuilder().setName('ask')
    .setDescription('Задать вопрос Марусе')
    .addStringOption((option) => option
      .setName('query')
      .setDescription('Вопрос')
      .setRequired(true)),
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
    guild,
    onUtterance: (text, userId, startedAt) => {
      handleUtterance(guild.id, text, userId, startedAt).catch((err) => console.error(err));
    },
    onSpeechStart: () => {
      const record = sessions.get(guild.id);
      if (record && record.listeningUntil > Date.now()) {
        record.session.duckMusic();
      }
    },
    onWake: (userId) => {
      const record = sessions.get(guild.id);
      if (record) {
        record.listeningUntil = Date.now() + LISTEN_WINDOW_MS;
        record.wakeUserId = userId;
        record.session.duckMusic();
        record.session.playChime();
      }
    },
    onEnd: () => {
      sessions.get(guild.id)?.session.unduckMusic();
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
    wakeUserId: null,
    textChannelId: textChannelId ?? null,
    nowPlayingMessage: null,
  };
  sessions.set(guild.id, record);
  session.onTrackStart = () => updateNowPlaying(record);
  session.onIdle = () => updateNowPlaying(record);
  speakUma(record.session, JOIN_GREETING);
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

// переход в другой канал без разрыва музыки: соединение переиспользуется (rejoin),
// плеер, очередь и слушатель остаются на месте
function moveSession(record, channel) {
  record.connection.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: false });
  console.log(`Перехожу в «${channel.name}»`);
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
  embed.addFields({ name: '🔊 Громкость', value: `${Math.round(session.musicVolume * 100)}%`, inline: true });
  const toggle = status === AudioPlayerStatus.Paused
    ? new ButtonBuilder().setCustomId('np:resume').setEmoji('▶️').setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder().setCustomId('np:pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('np:stop').setEmoji('⏹️').setStyle(ButtonStyle.Secondary),
    toggle,
    new ButtonBuilder().setCustomId('np:next').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('np:voldown').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('np:volup').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function updateNowPlaying(record) {
  if (sessions.get(record.guildId) !== record) return;

  // плеер показываем только пока играет музыка (в current лежит трек)
  if (record.session.current?.kind !== 'track') {
    if (record.nowPlayingMessage) {
      try {
        await record.nowPlayingMessage.delete();
      } catch {
      }
      record.nowPlayingMessage = null;
    }
    return;
  }

  const guild = client.guilds.cache.get(record.guildId);
  // плеер всегда пишется в канал spam
  const spam = guild?.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === 'spam');
  if (spam) record.textChannelId = spam.id;
  if (!record.textChannelId) {
    // голосовой запуск без текстового канала — берём системный или первый текстовый
    const fallbackId = guild?.systemChannelId
      ?? guild?.channels.cache.find((c) => c.type === ChannelType.GuildText)?.id
      ?? null;
    if (!fallbackId) return;
    record.textChannelId = fallbackId;
  }
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
    case 'volup':
      record.session.changeVolume(0.15);
      break;
    case 'voldown':
      record.session.changeVolume(-0.15);
      break;
    default:
      await interaction.deferUpdate().catch(() => {});
      return;
  }
  await interaction.update(buildNowPlayingContent(record)).catch(() => {});
}

const FOLLOWUP_STOP_WORDS = new Set([
  'хватит', 'стоп', 'замолчи', 'замолкни', 'молчи',
  'прекрати', 'остановись', 'отстань', 'заткнись',
]);

function hasStopWord(text) {
  const tokens = (text ?? '').toLowerCase().replaceAll('ё', 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);
  return tokens.some((token) => FOLLOWUP_STOP_WORDS.has(token));
}

async function handleUtterance(guildId, text, userId, startedAt) {
  const record = sessions.get(guildId);
  if (!record) return;
  const { matched, rest, wakeToken } = stripWake(text);

  if (matched) {
    console.log(`Голос -> команда: "${rest}" (wake: «${wakeToken}», было: "${text}")`);
    record.wakeUserId = userId;
    if (rest) {
      await runCommand(record, rest, userId);
    } else {
      record.listeningUntil = Date.now() + LISTEN_WINDOW_MS;
    }
    return;
  }

  // окно активно, если юзер НАЧАЛ говорить до его истечения
  if (record.listeningUntil && (startedAt ?? Date.now()) < record.listeningUntil) {
    // команду принимаем только от того, кто позвал
    if (record.wakeUserId !== userId) return;
    // стоп-слово в любом месте фразы («хватит», «замолчи», «прекрати»…) выключает слушание
    if (hasStopWord(text) || parseCommand(text)?.action === 'stop') {
      record.listeningUntil = 0;
      await speakUma(record.session, 'Молчу');
      return;
    }
    console.log(`Голос -> команда (без wake): "${text}"`);
    await runCommand(record, text, userId);
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
      console.log('Ассистент не настроен, нужен DEEPSEEK_API_KEY');
      await speakUma(record.session, 'Ассистент пока не настроен');
      return true;
    }
    try {
      record.listeningUntil = 0;
      const answer = await assistant.ask(userId, cmd.text);
      if (answer) {
        if (config.followupEnabled) {
          // окно слушания стартует после того, как озвучка закончится
          await speakUma(record.session, answer, () => {
            record.listeningUntil = Date.now() + FOLLOWUP_WINDOW_MS;
            record.wakeUserId = userId;
          });
        } else {
          await speakUma(record.session, answer);
        }
      }
    } catch (err) {
      console.error('Ассистент:', err.message);
      await speakUma(record.session, 'Что-то я тебе не поняла, попробуй ещё раз');
    }
    return true;
  }

  // музыкальные команды выключают режим диалога
  record.listeningUntil = 0;
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
        await interaction.deferReply();
        getSession(interaction.guild, voiceChannel, interaction.channelId);
        await interaction.editReply(`Села в «${voiceChannel.name}».`);
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
      case 'volume': {
        const record = sessions.get(interaction.guild.id);
        if (!record) {
          await interaction.reply({ content: 'Нет активной сессии', ephemeral: true });
          return;
        }
        const level = interaction.options.getInteger('level', true);
        const volume = record.session.setVolume(level / 100);
        await updateNowPlaying(record);
        await interaction.reply(`Громкость: ${Math.round(volume * 100)}%`);
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
      case 'ask': {
        const query = interaction.options.getString('query', true);
        if (!assistant) {
          await interaction.reply({ content: 'Ассистент не настроен (нужен DEEPSEEK_API_KEY)', ephemeral: true });
          return;
        }
        await interaction.deferReply();
        try {
          const answer = await assistant.ask(interaction.user.id, query);
          const text = answer?.trim() || 'Что-то я не поняла, попробуй иначе';
          const record = sessions.get(interaction.guild.id);
          if (record) {
            record.listeningUntil = 0;
            await speakUma(record.session, text);
          }
          await interaction.editReply(text);
        } catch (err) {
          console.error('Ассистент (ask):', err.message);
          await interaction.editReply('Что-то пошло не так');
        }
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
  if (newState.member?.user?.bot) return;

  const guild = newState.guild ?? oldState.guild;
  const record = sessions.get(guildId);

  // бот нигде не подключён — идём за любым пользователем, зашедшим в канал
  if (!record) {
    if (newState.channelId) {
      const channel = guild.channels.cache.get(newState.channelId);
      if (channel) getSession(guild, channel, null);
    }
    return;
  }

  const botChannelId = record.connection.joinConfig.channelId;

  // пользователь зашёл в канал бота — поздороваться по имени
  if (oldState.channelId !== botChannelId && newState.channelId === botChannelId) {
    const name = newState.member.displayName ?? newState.member.user.username;
    speakUma(record.session, `Привет, ${name}!`);
    return;
  }

  // пользователь ушёл из канала бота — озвучить и проверить, остался ли кто-то
  if (oldState.channelId === botChannelId && newState.channelId !== botChannelId) {
    const name = oldState.member?.displayName ?? 'кто-то';
    const channel = guild.channels.cache.get(botChannelId);
    const humans = channel?.members?.filter((member) => !member.user.bot).size ?? 0;
    if (humans > 0) speakUma(record.session, `${name} нас покинул`);

    setTimeout(() => {
      const current = sessions.get(guildId);
      if (!current || current.connection.joinConfig.channelId !== botChannelId) return;
      const ch = guild.channels.cache.get(botChannelId);
      const remaining = ch?.members?.filter((member) => !member.user.bot).size ?? 0;
      if (remaining > 0) return;
      const target = findPopulatedVoiceChannel(guild, botChannelId);
      if (target) moveSession(current, target);
      else destroySession(guildId);
    }, 2000);
  }
});

function findPopulatedVoiceChannel(guild, excludeChannelId) {
  return guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildVoice
    && channel.id !== excludeChannelId
    && channel.members?.some((member) => !member.user.bot)
  ) ?? null;
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.stack ?? err);
});

if (!config.discordToken) {
  console.error('Нет DISCORD_TOKEN в .env');
  process.exit(1);
}

client.login(config.discordToken).catch((err) => {
  console.error('Не удалось войти в Discord:', err.message);
  process.exit(1);
});
