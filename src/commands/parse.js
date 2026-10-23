import { config } from '../config.js';

export function normalize(text) {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[.,!?;:()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripWake(text) {
  const norm = normalize(text);
  const tokens = norm.split(' ');
  if (tokens.length && config.wakeWords.includes(tokens[0])) {
    return { matched: true, rest: tokens.slice(1).join(' ').trim() };
  }
  return { matched: false, rest: norm };
}

export function parseCommand(text) {
  const t = normalize(text);
  if (!t) return null;
  if (/^(стоп|хватит|все)$/.test(t)) return { action: 'stop' };
  if (/^(дальше|следующий|следующую|next|другой|другую|скип)$/.test(t)) {
    return { action: 'skip' };
  }
  if (/^(тише|потише)$/.test(t)) return { action: 'volume', delta: -0.15 };
  if (/^(громче|погромче)$/.test(t)) return { action: 'volume', delta: 0.15 };
  if (t === 'моя волна' || t === 'радио' || t === 'музыку' || t === 'музыка') {
    return { action: 'play', query: '__wave__' };
  }
  const play = t.match(/^(включи|запусти|поставь|играй)\s+(.+)$/);
  if (play) return { action: 'play', query: play[2].trim() };
  return { action: 'assistant', text: t };
}
