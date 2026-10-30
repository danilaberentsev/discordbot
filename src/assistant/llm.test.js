import { describe, expect, it, vi } from 'vitest';
import { askDeepSeek, normalizeCommand } from './llm.js';

const messages = [{ role: 'user', content: 'привет' }];

function stubFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{}' } }] }),
  }));
}

function bodyOf(fetchImpl) {
  return JSON.parse(fetchImpl.mock.calls[0][1].body);
}

function stubContent(content) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
}

describe('askDeepSeek', () => {
  it('includes response_format when responseFormat is truthy', async () => {
    const fetchImpl = stubFetch();
    await askDeepSeek(messages, { apiKey: 'k', responseFormat: { type: 'json_object' }, fetchImpl });
    expect(bodyOf(fetchImpl).response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when not passed', async () => {
    const fetchImpl = stubFetch();
    await askDeepSeek(messages, { apiKey: 'k', fetchImpl });
    expect(bodyOf(fetchImpl)).not.toHaveProperty('response_format');
  });

  it('forwards signal to fetch init', async () => {
    const fetchImpl = stubFetch();
    const signal = new AbortController().signal;
    await askDeepSeek(messages, { apiKey: 'k', signal, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBe(signal);
  });

  it('rejects when fetchImpl throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(askDeepSeek(messages, { apiKey: 'k', fetchImpl })).rejects.toThrow('boom');
  });

  it('keeps defaults for model, max_tokens and temperature', async () => {
    const fetchImpl = stubFetch();
    await askDeepSeek(messages, { apiKey: 'k', fetchImpl });
    const body = bodyOf(fetchImpl);
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0.6);
    expect(body.stream).toBe(false);
  });
});

describe('normalizeCommand', () => {
  it('sends json_object response_format, temperature 0, max_tokens 300 and a system prompt with "json"', async () => {
    const fetchImpl = stubContent('{"action":"stop"}');
    await normalizeCommand('стоп', { apiKey: 'k', fetchImpl });
    const body = bodyOf(fetchImpl);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(300);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/json/i);
    expect(body.messages[1]).toEqual({ role: 'user', content: 'стоп' });
  });

  it.each([
    ['{"action":"play","query":"__wave__"}', { action: 'play', query: '__wave__' }],
    ['{"action":"play","query":"__mywave__"}', { action: 'play', query: '__mywave__' }],
    ['{"action":"play","query":"три дня дождя плейлист"}', { action: 'play', query: 'три дня дождя плейлист' }],
    ['{"action":"stop"}', { action: 'stop' }],
    ['{"action":"skip"}', { action: 'skip' }],
    ['{"action":"volume","delta":-0.15}', { action: 'volume', delta: -0.15 }],
    ['{"action":"volume","delta":0.15}', { action: 'volume', delta: 0.15 }],
    ['{"action":"volume","level":0.5}', { action: 'volume', level: 0.5 }],
    ['{"action":"leave"}', { action: 'leave' }],
    ['{"action":"assistant","text":"сколько будет два плюс два"}', { action: 'assistant', text: 'сколько будет два плюс два' }],
  ])('returns golden %s', async (content, expected) => {
    const fetchImpl = stubContent(content);
    await expect(normalizeCommand('x', { apiKey: 'k', fetchImpl })).resolves.toEqual(expected);
  });

  it('strips unknown keys from a valid object', async () => {
    const fetchImpl = stubContent('{"action":"stop","extra":"boom"}');
    await expect(normalizeCommand('x', { apiKey: 'k', fetchImpl })).resolves.toEqual({ action: 'stop' });
  });

  it.each([
    [''],
    ['not json'],
    ['{"action":"nope"}'],
    ['{"action":"play"}'],
    ['{"action":"volume"}'],
  ])('rejects invalid content %j', async (content) => {
    const fetchImpl = stubContent(content);
    await expect(normalizeCommand('x', { apiKey: 'k', fetchImpl })).rejects.toThrow();
  });

  it('rejects when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); });
    await expect(normalizeCommand('x', { apiKey: 'k', fetchImpl })).rejects.toThrow('boom');
  });

  it('rejects on timeout (AbortSignal.timeout)', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
    }));
    await expect(normalizeCommand('x', { apiKey: 'k', timeoutMs: 10, fetchImpl })).rejects.toThrow();
  });
});
