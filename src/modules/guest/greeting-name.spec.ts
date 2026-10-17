import { greetingName } from './greeting-name';

describe('greetingName', () => {
  it('keeps a name: letters from any alphabet, accents, hyphens, apostrophes, dots, up to four words', () => {
    expect(greetingName('Sami')).toBe('Sami');
    expect(greetingName("Hélène Ben Ali-D'Or")).toBe("Hélène Ben Ali-D'Or");
    expect(greetingName('محمد بن علي')).toBe('محمد بن علي');
    expect(greetingName('M. Sami')).toBe('M. Sami');
    expect(greetingName('  Sami   Ben  ')).toBe('Sami Ben');
  });

  it('a sentence, a number or a link is not a name', () => {
    expect(greetingName('Votre compte est bloqué, appelez le 0600000000')).toBe('');
    expect(greetingName('Sami 2')).toBe('');
    expect(greetingName('Sami: urgent')).toBe('');
    expect(greetingName('http://evil.example')).toBe('');
    expect(greetingName('Sami!')).toBe('');
    expect(greetingName('a b c d e')).toBe('');
    expect(greetingName('x'.repeat(41))).toBe('');
  });

  it('control and invisible characters are taken out first', () => {
    expect(greetingName('Sa\u0000mi\u001b\u0007 Ben')).toBe('Sa mi Ben');
    expect(greetingName('Sami\u202E')).toBe('Sami');
    expect(greetingName('Sa\u200Bmi')).toBe('Sa mi');
    expect(greetingName('Sami\r\nBen')).toBe('Sami Ben');
    expect(greetingName('Sami\u2028Ben')).toBe('Sami Ben');
  });

  it('nothing, or something that is not text, greets nobody', () => {
    expect(greetingName(undefined)).toBe('');
    expect(greetingName(null)).toBe('');
    expect(greetingName(42)).toBe('');
    expect(greetingName('   ')).toBe('');
    expect(greetingName('\u202E')).toBe('');
  });
});
