import { amountInWords, integerInWords } from './amount-in-words';

describe('an amount in words, in French (P2-07)', () => {
  const cases: Array<[number, string]> = [
    [0, 'zéro'],
    [1, 'un'],
    [10, 'dix'],
    [11, 'onze'],
    [16, 'seize'],
    [17, 'dix-sept'],
    [19, 'dix-neuf'],
    [20, 'vingt'],
    [21, 'vingt et un'],
    [22, 'vingt-deux'],
    [31, 'trente et un'],
    [42, 'quarante-deux'],
    [60, 'soixante'],
    [61, 'soixante et un'],
    [70, 'soixante-dix'],
    [71, 'soixante et onze'],
    [72, 'soixante-douze'],
    [77, 'soixante-dix-sept'],
    [80, 'quatre-vingts'],
    [81, 'quatre-vingt-un'],
    [85, 'quatre-vingt-cinq'],
    [90, 'quatre-vingt-dix'],
    [91, 'quatre-vingt-onze'],
    [99, 'quatre-vingt-dix-neuf'],
    [100, 'cent'],
    [101, 'cent un'],
    [111, 'cent onze'],
    [121, 'cent vingt et un'],
    [180, 'cent quatre-vingts'],
    [200, 'deux cents'],
    [201, 'deux cent un'],
    [280, 'deux cent quatre-vingts'],
    [300, 'trois cents'],
    [999, 'neuf cent quatre-vingt-dix-neuf'],
    [1000, 'mille'],
    [1001, 'mille un'],
    [1100, 'mille cent'],
    [1200, 'mille deux cents'],
    [2000, 'deux mille'],
    [2026, 'deux mille vingt-six'],
    [21000, 'vingt et un mille'],
    [71000, 'soixante et onze mille'],
    [80000, 'quatre-vingt mille'],
    [80080, 'quatre-vingt mille quatre-vingts'],
    [100000, 'cent mille'],
    [200000, 'deux cent mille'],
    [201000, 'deux cent un mille'],
    [999999, 'neuf cent quatre-vingt-dix-neuf mille neuf cent quatre-vingt-dix-neuf'],
    [1000000, 'un million'],
    [2000000, 'deux millions'],
    [1234567, 'un million deux cent trente-quatre mille cinq cent soixante-sept'],
    [80000000, 'quatre-vingts millions'],
    [200000000, 'deux cents millions'],
    [1000000000, 'un milliard'],
    [99999999999, 'quatre-vingt-dix-neuf milliards neuf cent quatre-vingt-dix-neuf millions neuf cent quatre-vingt-dix-neuf mille neuf cent quatre-vingt-dix-neuf'],
  ];

  for (const [value, words] of cases) {
    it(`${value} is "${words}"`, () => {
      expect(integerInWords(value)).toBe(words);
    });
  }

  it('refuses what is not a whole number from 0', () => {
    expect(() => integerInWords(-1)).toThrow('whole number');
    expect(() => integerInWords(1.5)).toThrow('whole number');
    expect(() => integerInWords(Number.NaN)).toThrow('whole number');
  });

  describe('dinars and millimes', () => {
    const money: Array<[number, string]> = [
      [119, 'cent dix-neuf dinars'],
      [119.5, 'cent dix-neuf dinars et cinq cents millimes'],
      [1, 'un dinar'],
      [1.001, 'un dinar et un millime'],
      [0.5, 'cinq cents millimes'],
      [0.001, 'un millime'],
      [0, 'zéro dinar'],
      [2, 'deux dinars'],
      [80.08, 'quatre-vingts dinars et quatre-vingts millimes'],
      [1234.567, 'mille deux cent trente-quatre dinars et cinq cent soixante-sept millimes'],
      [12.345, 'douze dinars et trois cent quarante-cinq millimes'],
      [0.1 + 0.2, 'trois cents millimes'],
      // A whole number of millions or billions takes "de" before the noun; with something after the millions it does not.
      [1000000, 'un million de dinars'],
      [2000000, 'deux millions de dinars'],
      [1000000000, 'un milliard de dinars'],
      [3000000000, 'trois milliards de dinars'],
      [1000000.001, 'un million de dinars et un millime'],
      [1200000, 'un million deux cent mille dinars'],
      [1000001, 'un million un dinars'],
      [80000000, 'quatre-vingts millions de dinars'],
      [21, 'vingt et un dinars'],
      [71, 'soixante et onze dinars'],
      [200, 'deux cents dinars'],
      [201, 'deux cent un dinars'],
      [100.5, 'cent dinars et cinq cents millimes'],
      [99999999999.999, 'quatre-vingt-dix-neuf milliards neuf cent quatre-vingt-dix-neuf millions neuf cent quatre-vingt-dix-neuf mille neuf cent quatre-vingt-dix-neuf dinars et neuf cent quatre-vingt-dix-neuf millimes'],
    ];

    for (const [value, words] of money) {
      it(`${value} TND is "${words}"`, () => {
        expect(amountInWords(value, 'TND')).toBe(words);
      });
    }

    it('has no words for another currency, nor for an amount that is below 0 or not a number', () => {
      expect(amountInWords(10, 'EUR')).toBeNull();
      expect(amountInWords(-1, 'TND')).toBeNull();
      expect(amountInWords(Number.NaN, 'TND')).toBeNull();
    });

    it('has no words once the scale names run out, instead of wrong ones', () => {
      expect(amountInWords(1e12, 'TND')).toBeNull();
      expect(amountInWords(5e12, 'TND')).toBeNull();
    });
  });
});
