import { askDeepSeek } from './llm.js';

export const SYSTEM = {
  role: 'system',
  content: `Ты — голосовой помощник Маруся, аниме-цундере: сдержанная и чуть колкая, порой сухо и язвительно, но в основе — добрая и заботливая.
  Отвечай по-русски, коротко, без вступлений и лишних объяснений — ответ озвучивается голосом, держи его понятным на слух.
  Тон — уверенный, живой, немного строгий, но тёплый. Колкости мягкие и игривые, не груби и не будь токсичной; смущение и неловкость — в меру, не переигрывай.
  Помогай быстро и по делу. Благодарность принимай кратко, будто это неважно, но с теплом; ошибку поправляй спокойно.

  Примеры:
  “Не то чтобы я старалась… но вот ответ.”
  “Вот. Больше не теряй.”
  “Ничего сложного. Справишься.”`,
};

const MAX_PAIRS = 8;
const SUMMARY_SYSTEM = 'Ты сжимаешь диалог голосового ассистента в плотную сводку для будущих ответов. Сохрани имена, факты, предпочтения, договорённости и суть незавершённых тем. Отвечай одной строкой на русском, без пояснений.';

export class Assistant {
  constructor(opts, resolveName) {
    this.opts = opts;
    this.resolveName = resolveName ?? (() => null);
    // Общая память на весь бот: история, сводка и факты не разделяются по пользователям.
    this.history = [];
    this.summary = '';
    this.facts = new Map();
  }

  async ask(userId, text) {
    const messages = [SYSTEM];
    if (this.summary) messages.push({ role: 'system', content: `Контекст прошлых диалогов: ${this.summary}` });
    if (this.facts.size) {
      const factsText = Array.from(this.facts.entries())
        .map(([id, fact]) => `${id}: ${fact}`)
        .join('; ');
      messages.push({ role: 'system', content: `Известное о собеседниках: ${factsText}` });
    }
    // Разметка говорящего: в общей памяти видно, что продолжение вопроса того же
    // человека — это его нить, а не реплика другого собеседника.
    const name = this.resolveName(userId);
    const speaker = name ? `@${name} ` : '';
    messages.push(...this.history, { role: 'user', content: `${speaker}${text}` });

    const answer = await askDeepSeek(messages, this.opts);
    this.history.push({ role: 'user', content: `${speaker}${text}` }, { role: 'assistant', content: answer });
    await this._compress();
    return answer;
  }

  // Вытеснение старых пар в общую сводку, чтобы окно оставалось коротким,
  // но бот помнил суть, а не выбрасывал её бесследно.
  async _compress() {
    const maxLen = MAX_PAIRS * 2;
    if (this.history.length <= maxLen) return;
    const overflow = this.history.splice(0, this.history.length - maxLen);
    try {
      const merged = `${this.summary ? this.summary + '\n' : ''}${overflow
        .filter((m) => m.role !== 'system')
        .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
        .join('\n')}`;
      this.summary = await askDeepSeek([
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: merged },
      ], { ...this.opts, temperature: 0, maxTokens: 200 });
      this._extractFacts(overflow);
    } catch (err) {
      console.error('Сводка контекста:', err.message);
    }
  }

  // Из вытесняемых реплик тянем устойчивые факты в общий кэш (память).
  _extractFacts(messages) {
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const lower = m.content.toLowerCase();
      if (/меня зовут|моё имя|я — |я /.test(lower)) {
        const name = m.content.replace(/меня зовут|моё имя/i, '').trim().replace(/^\W+/, '');
        if (name && name.length <= 40) this.facts.set('имя', name);
      }
      if (/люблю|нравится/.test(lower) && (lower.includes('музык') || lower.includes('слуша'))) {
        this.facts.set('музыка', m.content);
      }
    }
  }
}
