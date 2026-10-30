import { describe, expect, it } from 'vitest';
import {
  cleanQuery,
  findWakeToken,
  hasWakeWord,
  isMyWaveIntent,
  isPlaylistIntent,
  isWakeToken,
  isWaveIntent,
  normalize,
  numbersToDigits,
  parseCommand,
  stripPlaylistWord,
  stripWake,
} from './parse.js';

describe('parseCommand — golden set', () => {
  it.each([
    ['включи музыку', { action: 'play', query: '__wave__' }],
    ['включи everything black', { action: 'play', query: 'everything black' }],
    ['стоп', { action: 'stop' }],
    ['дальше', { action: 'skip' }],
    ['тише', { action: 'volume', delta: -0.15 }],
    ['громче', { action: 'volume', delta: 0.15 }],
    ['громкость на 50', { action: 'volume', level: 0.5 }],
    ['моя волна', { action: 'play', query: '__mywave__' }],
    ['выйди', { action: 'leave' }],
    ['сколько будет два плюс два', { action: 'assistant', text: 'сколько будет два плюс два' }],
  ])('%s', (input, expected) => {
    expect(parseCommand(input)).toEqual(expected);
  });
});

describe('parseCommand — edge cases', () => {
  it('возвращает null на пустой строке', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  it('нормализует регистр и пунктуацию', () => {
    expect(parseCommand('Стоп!')).toEqual({ action: 'stop' });
  });

  it('резолвит алиас Space Glide в канонический запрос', () => {
    expect(parseCommand('спейс глайд')).toEqual({
      action: 'play',
      query: 'unlike pluto everything black',
    });
  });

  it('stop с существительным', () => {
    expect(parseCommand('выключи музыку')).toEqual({ action: 'stop' });
  });

  it('skip с существительным после глагола', () => {
    expect(parseCommand('включи дальше')).toEqual({ action: 'skip' });
  });

  it('leave для «пока»', () => {
    expect(parseCommand('пока')).toEqual({ action: 'leave' });
  });

  it('volume на максимум / минимум', () => {
    expect(parseCommand('громкость на максимум')).toEqual({ action: 'volume', level: 1 });
    expect(parseCommand('громкость на минимум')).toEqual({ action: 'volume', level: 0.05 });
  });

  it('play с очисткой филлеров в запросе', () => {
    expect(parseCommand('включи мне пожалуйста песню everything black')).toEqual({
      action: 'play',
      query: 'everything black',
    });
  });
});

describe('normalize', () => {
  it('нижний регистр, ё→е, пунктуация в пробелы, схлопывание', () => {
    expect(normalize('  Ёлка,   ПАДАЕТ!  ')).toBe('елка падает');
  });
});

describe('cleanQuery', () => {
  it('удаляет филлеры', () => {
    expect(cleanQuery('мне пожалуйста песню')).toBe('');
  });

  it('оставляет содержательные слова', () => {
    expect(cleanQuery('включи мне трек everything black')).toBe('включи everything black');
  });
});

describe('isWaveIntent', () => {
  it('generic-слово означает волну', () => {
    expect(isWaveIntent('музыку')).toBe(true);
  });

  it('пустой запрос означает волну', () => {
    expect(isWaveIntent('')).toBe(true);
  });

  it('конкретное название — не волна', () => {
    expect(isWaveIntent('everything black')).toBe(false);
  });
});

describe('isMyWaveIntent', () => {
  it('распознаёт фразы «моя волна»', () => {
    expect(isMyWaveIntent('моя волна')).toBe(true);
    expect(isMyWaveIntent('мою волну')).toBe(true);
    expect(isMyWaveIntent('моей волны')).toBe(true);
  });

  it('не путает с обычной волной', () => {
    expect(isMyWaveIntent('включи музыку')).toBe(false);
  });
});

describe('isPlaylistIntent / stripPlaylistWord', () => {
  it('распознаёт плейлист', () => {
    expect(isPlaylistIntent('три дня дождя плейлист')).toBe(true);
    expect(isPlaylistIntent('everything black')).toBe(false);
    expect(isPlaylistIntent('')).toBe(false);
  });

  it('убирает слово-плейлист', () => {
    expect(stripPlaylistWord('три дня дождя плейлист')).toBe('три дня дождя');
  });
});

describe('wake-слово', () => {
  it('isWakeToken знает дефолтное wake-слово и ослышки', () => {
    expect(isWakeToken('маруся')).toBe(true);
    expect(isWakeToken('моруся')).toBe(true);
    expect(isWakeToken('кот')).toBe(false);
  });

  it('findWakeToken срабатывает только на первое слово', () => {
    expect(findWakeToken('маруся, включи музыку')).toBe('маруся');
    expect(findWakeToken('включи маруся')).toBeNull();
  });

  it('hasWakeWord', () => {
    expect(hasWakeWord('маруся включи музыку')).toBe(true);
    expect(hasWakeWord('включи музыку')).toBe(false);
  });

  it('stripWake отделяет остаток и токен', () => {
    expect(stripWake('маруся включи музыку')).toEqual({
      matched: true,
      rest: 'включи музыку',
      wakeToken: 'маруся',
    });
  });

  it('stripWake без wake-слова возвращает фразу целиком', () => {
    expect(stripWake('включи музыку')).toEqual({
      matched: false,
      rest: 'включи музыку',
      wakeToken: null,
    });
  });
});

describe('numbersToDigits', () => {
  it('склеивает разряды', () => {
    expect(numbersToDigits('две тысячи десять')).toBe('2010');
  });

  it('десятки + единицы', () => {
    expect(numbersToDigits('двадцать пять')).toBe('25');
  });

  it('не трогает нечисловые слова', () => {
    expect(numbersToDigits('трек две тысячи десять')).toBe('трек 2010');
  });
});
