import { config } from '../config.js';

export function normalize(text) {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[.,!?;:()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(text) {
  return normalize(text)
    .replaceAll('э', 'е')
    .replaceAll('й', 'и')
    .replace(/[^а-яa-z]/g, '');
}

const SPACEGLIDE_QUERY = 'unlike pluto everything black';

const SPACEGLIDE_VARIANTS = [
  'спейс глайд',
  'спейс глейд',
  'спейс глайт',
  'спейс глейт',
  'спейс гляйд',
  'спейс глай',
  'спейс глей',
  'space glide',
  'spaceglide',
];

const ALIASES = new Map(
  SPACEGLIDE_VARIANTS.map((variant) => [compact(variant), SPACEGLIDE_QUERY]),
);

export function stripWake(text) {
  const norm = normalize(text);
  const tokens = norm.split(' ');
  if (!tokens.some((token) => config.wakeWords.includes(token))) {
    return { matched: false, rest: norm };
  }
  const rest = tokens.filter((token) => !config.wakeWords.includes(token)).join(' ').trim();
  return { matched: true, rest };
}

export function parseCommand(text) {
  const t = normalize(text);
  if (!t) return null;
  const alias = ALIASES.get(compact(t));
  if (alias) return { action: 'play', query: alias };
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
