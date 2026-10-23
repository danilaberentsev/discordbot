import { askYandexGpt } from './llm.js';

const SYSTEM = {
  role: 'system',
  text: 'Ты голосовой ассистент Алиса в Discord. Отвечай по-русски, живо и дружелюбно, максимум два коротких предложения. Без markdown, без списков, без эмодзи.',
};
const MAX_PAIRS = 4;

export class Assistant {
  constructor(opts) {
    this.opts = opts;
    this.histories = new Map();
  }

  async ask(userId, text) {
    const history = this.histories.get(userId) ?? [];
    const messages = [SYSTEM, ...history, { role: 'user', text }];
    const answer = await askYandexGpt(messages, this.opts);
    history.push({ role: 'user', text }, { role: 'assistant', text: answer });
    this.histories.set(userId, history.slice(-MAX_PAIRS * 2));
    return answer;
  }
}
