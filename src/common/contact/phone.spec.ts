import { ConflictException } from '@nestjs/common';

import { phoneColumns, phoneKeyOf, phoneWhere, rethrowContactConflict } from './phone';

describe('phoneKeyOf', () => {
  it('one number, one key, whatever the spelling', () => {
    for (const spelling of ['22 123 456', '22123456', '+216 22 123 456', '+21622123456', '0021622123456', '21622123456', '(22) 123-456']) {
      expect(phoneKeyOf(spelling)).toBe('+21622123456');
    }
  });

  it('different numbers keep different keys', () => {
    expect(phoneKeyOf('22 123 457')).toBe('+21622123457');
    expect(phoneKeyOf('+33 6 12 34 56 78')).toBe('+33612345678');
  });

  it('nothing and nonsense have no key', () => {
    expect(phoneKeyOf('')).toBeNull();
    expect(phoneKeyOf('   ')).toBeNull();
    expect(phoneKeyOf(null)).toBeNull();
    expect(phoneKeyOf(undefined)).toBeNull();
    expect(phoneKeyOf('call me')).toBeNull();
    expect(phoneKeyOf('123')).toBeNull();
  });
});

describe('phoneColumns', () => {
  it('keeps what was typed and adds the key', () => {
    expect(phoneColumns('  22 123 456 ')).toEqual({ phone: '22 123 456', phoneKey: '+21622123456' });
  });

  it('empty means "no number"', () => {
    expect(phoneColumns('')).toEqual({ phone: null, phoneKey: null });
    expect(phoneColumns(null)).toEqual({ phone: null, phoneKey: null });
    expect(phoneColumns(undefined)).toEqual({ phone: null, phoneKey: null });
  });

  it('refuses what cannot be a phone number', () => {
    let status = 0;

    try {
      phoneColumns('abc');
    } catch (error: any) {
      status = error.status;
    }

    expect(status).toBe(400);
  });
});

describe('phoneWhere', () => {
  it('finds the key and, for old rows, the text as typed', () => {
    expect(phoneWhere('22 123 456')).toEqual({ OR: [{ phoneKey: '+21622123456' }, { phone: '22 123 456', deletedAt: null }] });
  });

  it('falls back to the text when there is no key, and to nothing when empty', () => {
    expect(phoneWhere('abc')).toEqual({ phone: 'abc', deletedAt: null });
  });

  it('a blank number matches nobody: it must never turn a lookup into "any account"', () => {
    for (const blank of ['', '   ', undefined, null]) {
      expect(phoneWhere(blank as any)).toEqual({ id: { in: [] } });
    }
  });
});

describe('rethrowContactConflict', () => {
  const unique = (target: unknown) => Object.assign(new Error('unique'), { code: 'P2002', meta: target });

  function run(error: unknown): any {
    try {
      rethrowContactConflict(error);
    } catch (thrown) {
      return thrown;
    }

    return null;
  }

  it('a taken number or e-mail becomes a 409, in either shape Prisma reports it', () => {
    const phone = run(unique({ target: ['phoneKey'] }));
    const phoneAdapter = run(unique({ driverAdapterError: { cause: { constraint: { fields: ['phoneKey'] } } } }));
    const email = run(unique({ target: ['email'] }));

    expect(phone instanceof ConflictException).toBe(true);
    expect(phone.message).toBe('Ce numéro de téléphone est déjà utilisé.');
    expect(phoneAdapter instanceof ConflictException).toBe(true);
    expect(email.message).toBe('Cet email est déjà utilisé.');
  });

  it('a violation of another column is rethrown untouched, so is any other error', () => {
    const other = unique({ target: ['tokenHash'] });
    const adapter = unique({ driverAdapterError: { cause: { constraint: { fields: ['tokenHash'] } } } });
    const plain = new Error('boom');

    expect(run(other)).toBe(other);
    expect(run(adapter)).toBe(adapter);
    expect(run(plain)).toBe(plain);
  });

  it('only the sentence that names the column counts, not the code of the failing call that Prisma may put in front of it', async () => {
    const framed = (column: string) =>
      Object.assign(
        new Error(
          'Invalid `prisma.user.create()` invocation:\n\n  data: { email: "a@b.tn", phone: "22", phoneKey: "+21622" }\n\n' +
            `Unique constraint failed on the fields: (\`${column}\`)`,
        ),
        { code: 'P2002' },
      );

    expect(run(framed('email')).message).toBe('Cet email est déjà utilisé.');
    expect(run(framed('phoneKey')).message).toBe('Ce numéro de téléphone est déjà utilisé.');
  });

  it('a violation that names no column is still one of the two User details: a 409, not a 500', () => {
    for (const bare of [unique(undefined), unique({}), Object.assign(new Error('x'), { code: 'P2002' })]) {
      const thrown = run(bare);

      expect(thrown instanceof ConflictException).toBe(true);
      expect(thrown.message).toBe('Cet email ou ce numéro de téléphone est déjà utilisé.');
    }
  });
});
