import { flattenVars, renderTemplate } from './render-template';

describe('renderTemplate', () => {
  it('fills placeholders, with or without spaces', () => {
    expect(renderTemplate('Bonjour {{name}}, code {{ code }}.', { name: 'Sami', code: 123456 })).toBe(
      'Bonjour Sami, code 123456.',
    );
  });

  it('a missing value becomes empty and nothing is evaluated', () => {
    expect(renderTemplate('A{{missing}}B{{nothing}}C', { nothing: null })).toBe('ABC');
    expect(renderTemplate('{{constructor}} {{__proto__}}', {})).toBe(' ');
    expect(renderTemplate('{{ 1+1 }} ${x}', {})).toBe('{{ 1+1 }} ${x}');
  });

  it('the same placeholder can appear several times', () => {
    expect(renderTemplate('{{a}}{{a}}', { a: 'x' })).toBe('xx');
  });
});

describe('flattenVars', () => {
  it('keeps simple values, one level of nesting, skips arrays', () => {
    expect(flattenVars({ quoteId: 7, ok: true, who: 'x', list: [1], deep: { a: 1, deeper: { b: 2 } } })).toEqual({
      quoteId: 7,
      ok: true,
      who: 'x',
      'deep.a': 1,
      'deep.deeper.b': 2,
    });
    expect(flattenVars(null)).toEqual({});
    expect(flattenVars('text')).toEqual({});
  });
});
