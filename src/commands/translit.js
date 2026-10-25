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

export function translitFallbacks(text) {
  const base = translit(text.trim());
  if (!base || !/[a-z]/.test(base)) return [];
  const candidates = new Set([base]);
  const zVariant = base.replace(/s/g, 'z');
  if (zVariant !== base) candidates.add(zVariant);
  const tokens = base.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (['blek', 'blak', 'bek'].includes(last)) {
    tokens[tokens.length - 1] = 'black';
    candidates.add(tokens.join(' '));
  }
  return [...candidates];
}
