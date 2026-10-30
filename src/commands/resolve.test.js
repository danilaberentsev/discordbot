import { describe, expect, it, vi } from 'vitest';
import { resolveCommand } from './resolve.js';
import { parseCommand } from './parse.js';

describe('resolveCommand', () => {
  it('без apiKey — детерминированный parseCommand, LLM не зовётся', async () => {
    const stub = vi.fn();
    const result = await resolveCommand('включи музыку', { normalize: stub });

    expect(stub.mock.calls.length).toBe(0);
    expect(result).toEqual(parseCommand('включи музыку'));
  });

  it('с apiKey — результат LLM-нормализатора', async () => {
    const stub = vi.fn().mockResolvedValue({ action: 'play', query: 'x' });
    const result = await resolveCommand('вруби что-то', { apiKey: 'test-key', timeoutMs: 1000, normalize: stub });

    expect(result).toEqual({ action: 'play', query: 'x' });
    expect(stub.mock.calls.length).toBe(1);
    expect(stub.mock.calls[0][0]).toBe('вруби что-то');
  });

  it('с apiKey — ошибка нормализатора даёт fallback на parseCommand', async () => {
    const text = 'включи everything black';
    const stub = vi.fn().mockRejectedValue(new Error('DeepSeek 500: boom'));
    const result = await resolveCommand(text, { apiKey: 'test-key', normalize: stub });

    expect(result).toEqual(parseCommand(text));
  });

  it('с apiKey — фолбэк совпадает по форме для известной фразы', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await resolveCommand('стоп', { apiKey: 'test-key', normalize: stub });

    expect(result).toEqual(parseCommand('стоп'));
    expect(result).toEqual({ action: 'stop' });
  });
});
