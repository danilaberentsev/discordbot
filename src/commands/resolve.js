import { normalizeCommand } from '../assistant/llm.js';
import { parseCommand } from './parse.js';

export async function resolveCommand(text, { apiKey, timeoutMs, normalize = normalizeCommand } = {}) {
  if (!apiKey) return parseCommand(text);
  try {
    return await normalize(text, { apiKey, timeoutMs });
  } catch (err) {
    console.log('Нормализация не удалась, fallback на parseCommand:', err.message);
    return parseCommand(text);
  }
}
