const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function translit(text) {
  let out = '';
  for (const ch of text.toLowerCase()) {
    out += Object.prototype.hasOwnProperty.call(MAP, ch) ? MAP[ch] : ch;
  }
  return out;
}

// обратный транслит (латиница → кириллица), жадное сопоставление по длине
const REVERSE_MAP = [
  ['sch', 'щ'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'], ['ts', 'ц'],
  ['kh', 'х'], ['yu', 'ю'], ['ya', 'я'],
  ['a', 'а'], ['b', 'б'], ['c', 'ц'], ['d', 'д'], ['e', 'е'], ['f', 'ф'],
  ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'дж'], ['k', 'к'], ['l', 'л'],
  ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'],
  ['t', 'т'], ['u', 'у'], ['v', 'в'], ['w', 'в'], ['x', 'кс'], ['y', 'й'],
  ['z', 'з'],
];

export function translitReverse(text) {
  const s = (text ?? '').toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (const [latin, cyr] of REVERSE_MAP) {
      if (s.startsWith(latin, i)) {
        out += cyr;
        i += latin.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

// частые оглушения/редукции, которые не ловит ни транслит, ни Левенштейн
const WORD_CORRECTIONS = {
  blek: 'black',
  blak: 'black',
  bek: 'black',
};

export function translitFallbacks(text) {
  const base = translit(text.trim());
  if (!base || !/[a-z]/.test(base)) return [];
  const candidates = new Set([base]);
  const add = (s) => {
    if (s && s !== base && /[a-z]/.test(s)) candidates.add(s);
  };

  add(base.replace(/s/g, 'z'));
  add(base.replace(/z/g, 's'));
  add(base.replace(/v/g, 'w'));
  add(base.replace(/w/g, 'v'));
  add(base.replace(/dzh/g, 'j'));
  add(base.replace(/dj/g, 'j'));

  // смешанный язык: добавить вариант с латиницей → кириллицей
  if (/[a-z]/.test(text) && /[а-яё]/.test(text)) {
    const cyr = translitReverse(base);
    if (cyr) candidates.add(cyr);
  }

  const tokens = base.split(/\s+/);
  const last = tokens[tokens.length - 1];
  const correction = WORD_CORRECTIONS[last];
  if (correction) {
    tokens[tokens.length - 1] = correction;
    add(tokens.join(' '));
  }

  return [...candidates].slice(0, 8);
}
