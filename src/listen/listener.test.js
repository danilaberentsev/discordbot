import { describe, expect, it } from 'vitest';
import { VoiceListener } from './listener.js';

const connection = { receiver: { speaking: { on() {}, off() {} } } };

function makeGuild(users) {
  const voiceStates = new Map();
  const members = new Map();
  for (const [id, member] of Object.entries(users)) {
    voiceStates.set(id, { member });
    members.set(id, member);
  }
  return { voiceStates: { cache: voiceStates }, members: { cache: members } };
}

describe('VoiceListener — игнор ботов', () => {
  it('другой бот в канале не запускает распознавание', () => {
    const started = [];
    const listener = new VoiceListener(connection, 'self', {
      guild: makeGuild({ otherbot: { user: { bot: true }, displayName: 'OtherBot' } }),
      onSpeechStart: (userId) => started.push(userId),
    });

    listener.beginUser('otherbot');

    expect(listener.isRecording()).toBe(false);
    expect(started).toEqual([]);
  });

  it('собственный id тоже не пишется', () => {
    const listener = new VoiceListener(connection, 'self', { guild: makeGuild({}) });

    listener.beginUser('self');

    expect(listener.isRecording()).toBe(false);
  });

  it('человека принимает', () => {
    const started = [];
    const listener = new VoiceListener(connection, 'self', {
      guild: makeGuild({ human: { user: { bot: false }, displayName: 'Вася' } }),
      onSpeechStart: (userId) => started.push(userId),
    });

    listener.beginUser('human');

    expect(listener.isRecording()).toBe(true);
    expect(started).toEqual(['human']);
  });
});
