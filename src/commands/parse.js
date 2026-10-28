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

// «моя волна» — персональная радиостанция (отличается от топ-чарта «волны»)
const MY_WAVE_PHRASES = new Set(['моя волна', 'мою волну', 'моей волны']);

export function isMyWaveIntent(text) {
  return MY_WAVE_PHRASES.has(normalize(text));
}

const PLAYLIST_WORDS = new Set(['плейлист', 'плейлисты', 'плейлиста', 'сборник', 'сборники', 'сборника']);

export function isPlaylistIntent(q) {
  if (!q) return false;
  return q.split(' ').some((t) => PLAYLIST_WORDS.has(t));
}

export function stripPlaylistWord(text) {
  return text.split(' ').filter((t) => !PLAYLIST_WORDS.has(t)).join(' ').trim();
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

// ослышки wake-слова «аделина»: только прямые фонетические искажения.
// Частотные имена/слова с хвостом «-лина» (галина, полина, малина…) дают ложные срабатывания — не добавлять.
const WAKE_VARIANTS = new Set([
  // редукция гласных / обрезка безударного начала (а-де-ли-на ≈ да-ли-на)
  'долина', 'алина', 'лина', 'делина', 'елина', 'оделина',
  // орфография и замены согласных
  'адэлина', 'адерина',
]);

export function isWakeToken(token) {
  if (config.wakeWords.includes(token)) return true;
  if (WAKE_VARIANTS.has(token)) return true;
  return false;
}

export function findWakeToken(text) {
  return normalize(text).split(' ').find(isWakeToken) ?? null;
}

export function hasWakeWord(text) {
  return findWakeToken(text) !== null;
}

export function stripWake(text) {
  const norm = normalize(text);
  const tokens = norm.split(' ');
  const wakeToken = tokens.find(isWakeToken);
  if (!wakeToken) {
    return { matched: false, rest: norm, wakeToken: null };
  }
  const rest = tokens.filter((token) => !isWakeToken(token)).join(' ').trim();
  return { matched: true, rest, wakeToken };
}

const SKIP_WORDS = new Set(['дальше', 'следующий', 'следующая', 'следующую', 'next', 'другой', 'другую', 'скип']);
const SKIP_NOUNS = new Set(['трек', 'треки', 'трэк', 'песню', 'песня', 'песни', 'композицию', 'композиция']);
const STOP_NOUNS = new Set(['музыку', 'музыка', 'песню', 'песни', 'трек', 'треки', 'звук']);

function isSkipIntent(t) {
  const [first, ...rest] = t.split(' ');
  return SKIP_WORDS.has(first) && rest.every((tok) => SKIP_NOUNS.has(tok));
}

function isStopIntent(t) {
  const [first, ...rest] = t.split(' ');
  return (first === 'стоп' || first === 'хватит' || first === 'все')
    && rest.every((tok) => STOP_NOUNS.has(tok));
}

export function parseCommand(text) {
  const t = normalize(text);
  if (!t) return null;
  const alias = ALIASES.get(compact(t));
  if (alias) return { action: 'play', query: alias };
  if (isStopIntent(t)) return { action: 'stop' };
  if (isSkipIntent(t)) return { action: 'skip' };
  if (/^(выйди|уйди|выходи|уходи|отключись|пока)(\s|$)/.test(t)) {
    return { action: 'leave' };
  }
  if (/^(тише|потише)$/.test(t)) return { action: 'volume', delta: -0.15 };
  if (/^(громче|погромче)$/.test(t)) return { action: 'volume', delta: 0.15 };
  const volLevel = parseVolumeLevel(t);
  if (volLevel !== null) return { action: 'volume', level: volLevel };
  if (isMyWaveIntent(t)) return { action: 'play', query: '__mywave__' };
  if (t === 'радио' || isWaveIntent(t)) {
    return { action: 'play', query: '__wave__' };
  }
  const play = t.match(/^(?:хочу\s+)?(?:послушать|слушать|послушай|включить|включи|запустить|запусти|поставь|поставить|играй|сыграй)\s+(.+)$/);
  if (play) {
    const q = cleanQuery(play[1]);
    if (isSkipIntent(q)) return { action: 'skip' };
    if (isMyWaveIntent(q)) return { action: 'play', query: '__mywave__' };
    if (isWaveIntent(q)) return { action: 'play', query: '__wave__' };
    return { action: 'play', query: q };
  }
  return { action: 'assistant', text: t };
}
