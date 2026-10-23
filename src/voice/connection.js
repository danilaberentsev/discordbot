import { joinVoiceChannel } from '@discordjs/voice';

export function connectToChannel(channel) {
  return joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    debug: true,
  });
}
