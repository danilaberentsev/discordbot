export function tokenize(text) {
  return (text ?? '').toLowerCase().replace(/[^a-zа-яё0-9]/g, ' ').split(/\s+/).filter(Boolean);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// 0..1: похожесть слов, ниже порога — 0 (чтобы «gold» не матчил «golden»)
function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const ratio = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return ratio >= 0.75 ? ratio : 0;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// совпадение фразы по границам слов: «black» не считается внутри «blackout»
function phraseMatch(hay, phrase) {
  return new RegExp(`(^|[^a-zа-яё0-9])${escapeRegExp(phrase)}([^a-zа-яё0-9]|$)`).test(hay);
}

export function scoreTrack(track, query) {
  const q = (query ?? '').toLowerCase().trim();
  const qTokens = tokenize(q);
  if (!qTokens.length) return 0;

  const title = (track.title ?? '').toLowerCase();
  const artist = (track.artists ?? '').toLowerCase();
  const tTokens = tokenize(track.title);
  const aTokens = tokenize(track.artists);

  let score = 0;
  if (title === q) score += 100;
  else if (phraseMatch(title, q)) score += 70;
  else if (phraseMatch(artist, q)) score += 40;

  for (const qt of qTokens) {
    let bestT = 0;
    for (const t of tTokens) bestT = Math.max(bestT, wordSimilarity(qt, t));
    let bestA = 0;
    for (const a of aTokens) bestA = Math.max(bestA, wordSimilarity(qt, a));
    score += Math.max(bestT * 15, bestA * 8);
  }
  return Math.round(score);
}
