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

const FILLER_WORDS = new Set([
  'мне', 'нам', 'пожалуйста', 'плиз',
  'песню', 'песенку', 'трек', 'треки', 'музыку',
  'давай', 'ну', 'вот', 'это', 'эту', 'этот',
  'просто', 'любую', 'любой', 'любая',
]);

// «просто музыка» без конкретного названия: слова, означающие generic-интент
const WAVE_WORDS = new Set([
  'музыку', 'музыка', 'музыки',
  'песню', 'песня', 'песенку',
  'трек', 'треки',
  'что-нибудь', 'чтонибудь', 'что-то', 'чтото',
  'популярное', 'популярную', 'популярный', 'популярная', 'популярные',
  'хит', 'хиты', 'хитов', 'топ', 'чарт', 'плейлист', 'подборку', 'подборка',
]);

export function isWaveIntent(q) {
  if (!q) return true;
  return q.split(' ').every((t) => WAVE_WORDS.has(t));
}

export function cleanQuery(text) {
  const tokens = normalize(text).split(' ').filter((t) => !FILLER_WORDS.has(t));
  return tokens.join(' ').trim();
}

const NUMBER_WORDS = {
  ноль: 0, пять: 5, десять: 10, пятнадцать: 15, двадцать: 20,
  двадцатьпять: 25, тридцать: 30, тридцатьпять: 35, сорок: 40,
  сорокпять: 45, пятьдесят: 50, пятьдесятпять: 55, шестьдесят: 60,
  шестьдесятпять: 65, семьдесят: 70, семьдесятпять: 75, восемьдесят: 80,
  восемьдесятпять: 85, девяносто: 90, девяностопять: 95, сто: 100,
};

const MAX_WORDS = new Set(['максимум', 'максимальную', 'максимальная', 'максимальный']);
const MIN_WORDS = new Set(['минимум', 'минимальную', 'минимальная', 'минимальный']);

function parseVolumeLevel(t) {
  const s = t.trim();
  let target = s;
  const m = s.match(/^(?:громкость|звук)\s+(?:на\s+)?(.+)$/);
  if (m) target = m[1];
  else if (s.startsWith('на ')) target = s.slice(3);

  if (MAX_WORDS.has(target)) return 1;
  if (MIN_WORDS.has(target)) return 0.05;

  const raw = target.replace(/процент(?:ов|а|ы)?|%|\s+/g, '');
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw);
    return n >= 0 && n <= 100 ? n / 100 : null;
  }
  const word = NUMBER_WORDS[raw];
  return word !== undefined ? word / 100 : null;
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
  if (/^(выйди|уйди|выходи|уходи|отключись|пока)(\s|$)/.test(t)) {
    return { action: 'leave' };
  }
  if (/^(тише|потише)$/.test(t)) return { action: 'volume', delta: -0.15 };
  if (/^(громче|погромче)$/.test(t)) return { action: 'volume', delta: 0.15 };
  const volLevel = parseVolumeLevel(t);
  if (volLevel !== null) return { action: 'volume', level: volLevel };
  if (t === 'моя волна' || t === 'радио' || isWaveIntent(t)) {
    return { action: 'play', query: '__wave__' };
  }
  const play = t.match(/^(?:хочу\s+)?(?:послушать|слушать|послушай|включить|включи|запустить|запусти|поставь|поставить|играй|сыграй)\s+(.+)$/);
  if (play) {
    const q = cleanQuery(play[1]);
    if (isWaveIntent(q)) return { action: 'play', query: '__wave__' };
    return { action: 'play', query: q };
  }
  return { action: 'assistant', text: t };
}
