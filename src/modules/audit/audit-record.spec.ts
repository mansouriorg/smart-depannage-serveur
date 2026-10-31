import { HttpException, NotFoundException } from '@nestjs/common';

import {
  GLOBAL_PREFIX,
  MAX_DETAIL_LENGTH,
  MAX_FIELD_NAMES,
  WRITE_METHODS,
  auditRouteKey,
  FREE_TEXT_DETAILS,
  canonicalId,
  changedFieldsOf,
  cleanText,
  cutText,
  detailsOf,
  idFromResult,
  isSensitiveField,
  statusOfError,
} from './audit-record';

describe('what the audit log keeps of a request (P3-02)', () => {
  describe('the key of a route', () => {
    it('drops the global prefix, the names of the parameters and a trailing slash', () => {
      expect(auditRouteKey('patch', '/api/users/:id/reactivate')).toBe('PATCH /users/:/reactivate');
      expect(auditRouteKey('POST', '/api/matching/admin/interventions/:interventionId/assign/:artisanId')).toBe('POST /matching/admin/interventions/:/assign/:');
      expect(auditRouteKey('DELETE', '/api/files/:fileId/')).toBe('DELETE /files/:');
      expect(auditRouteKey('POST', '/api/users')).toBe('POST /users');
    });

    it('does not take a path that only starts like the prefix for the prefix', () => {
      expect(GLOBAL_PREFIX).toBe('/api');
      expect(auditRouteKey('POST', '/apiary/hives')).toBe('POST /apiary/hives');
    });

    it('answers a key even when Express gave no route, so a row can still be written', () => {
      expect(auditRouteKey('POST', undefined)).toBe('POST <unknown>');
      expect(auditRouteKey('POST', null)).toBe('POST <unknown>');
      expect(auditRouteKey('POST', '')).toBe('POST <unknown>');
    });

    it('logs the methods that change something and only those', () => {
      expect([...WRITE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
    });
  });

  describe('the names of the fields that were sent', () => {
    it('keeps the names, never the values', () => {
      const names = changedFieldsOf({ role: 'ADMIN', password: 'hunter2-Secret', isActive: false });

      expect(names).toEqual(['role', 'password', 'isActive']);
      expect(JSON.stringify(names)).not.toContain('hunter2');
    });

    it('leaves out a field that is undefined, a name that is not a plain word, and a name that is too long', () => {
      const body: Record<string, unknown> = { kept: 1, gone: undefined, '<script>': 1, 'a b': 2, [`x${'y'.repeat(80)}`]: 3, 'address.city': 4 };

      expect(changedFieldsOf(body)).toEqual(['kept', 'address.city']);
    });

    it('stops at the limit', () => {
      const body: Record<string, number> = {};
      for (let i = 0; i < MAX_FIELD_NAMES + 20; i += 1) body[`field${i}`] = i;

      expect(changedFieldsOf(body)).toHaveLength(MAX_FIELD_NAMES);
    });

    it('says a file came with the request, once', () => {
      expect(changedFieldsOf({ note: 'x' }, true)).toEqual(['note', 'file']);
      expect(changedFieldsOf({ file: 'x' }, true)).toEqual(['file']);
      expect(changedFieldsOf(undefined, true)).toEqual(['file']);
    });

    it('has nothing to say about a body that is not an object', () => {
      expect(changedFieldsOf(undefined)).toEqual([]);
      expect(changedFieldsOf(null)).toEqual([]);
      expect(changedFieldsOf('text')).toEqual([]);
      expect(changedFieldsOf(['a', 'b'])).toEqual([]);
    });
  });

  describe('the values kept', () => {
    it('keeps the fields the action names, from the path first and the body second (the path is what the route acted on)', () => {
      const details = detailsOf(['status', 'artisanId', 'isActive', 'amount'], { status: 'CANCELLED', artisanId: '99', isActive: false, amount: 12.5 }, { artisanId: '7', status: 'IGNORED' });

      expect(details).toEqual({ status: 'IGNORED', artisanId: 7, isActive: false, amount: 12.5 });
    });

    it('keeps nothing that is not asked for', () => {
      expect(detailsOf(['status'], { status: 'A', note: 'private words', password: 'x' }, {})).toEqual({ status: 'A' });
      expect(detailsOf(undefined, { status: 'A' }, {})).toBeNull();
      expect(detailsOf([], { status: 'A' }, {})).toBeNull();
    });

    it('keeps texts, finite numbers and booleans, and nothing else', () => {
      const body = { a: { deep: 1 }, b: ['x'], c: null, d: undefined, e: Number.NaN, f: Number.POSITIVE_INFINITY, g: '   ', h: new Date(), i: 0, j: false };

      expect(detailsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], body, {})).toEqual({ i: 0, j: false });
      expect(detailsOf(['a', 'b', 'c'], body, {})).toBeNull();
    });

    it('cuts a long reason and trims a short code', () => {
      const long = 'é'.repeat(MAX_DETAIL_LENGTH + 50);
      const kept = detailsOf(['reason', 'status'], { reason: long, status: '  DONE  ' }, {});

      expect(kept?.status).toBe('DONE');
      expect(String(kept?.reason)).toHaveLength(MAX_DETAIL_LENGTH);
      expect(String(kept?.reason).endsWith('…')).toBe(true);
    });

    it('keeps a sentence only for a reason; any other text must look like a code or an id', () => {
      const body = { reason: 'Doublon : le client a payé deux fois', status: 'a sentence a person typed', decision: 'REFUND_APPROVED', method: 'CASH', kind: 'BEFORE.1', artisanId: '7', type: '<b>x</b>', role: 'SUPPORT; DROP' };

      expect(detailsOf(['reason', 'status', 'decision', 'method', 'kind', 'artisanId', 'type', 'role'], body, {})).toEqual({
        reason: 'Doublon : le client a payé deux fois',
        decision: 'REFUND_APPROVED',
        method: 'CASH',
        kind: 'BEFORE.1',
        artisanId: 7,
      });
    });

    it('only a reason is a free text: the set is pinned, so a new free-text field is a decision made in this file', () => {
      expect([...FREE_TEXT_DETAILS]).toEqual(['reason']);
    });

    it('a number that came as text is kept as the number the handler reads, and a text that only starts like one is not kept', () => {
      const text = (value: string) => detailsOf(['amount'], { amount: value }, {});

      expect(text('12.50')).toEqual({ amount: 12.5 });
      expect(text('0007')).toEqual({ amount: 7 });
      expect(text('-3')).toEqual({ amount: -3 });
      expect(text('+4')).toEqual({ amount: 4 });

      for (const value of ['0x7D0', '2e3', '2E3', '.5', '1_000', '1,5', '12abc', '0b101', '9007199254740993', '1e999', '٣']) expect([value, text(value)]).toEqual([value, null]);

      expect(text('ABC123')).toEqual({ amount: 'ABC123' });
      expect(text('CASH')).toEqual({ amount: 'CASH' });
    });

    it('takes the control characters out of a text: a NUL cannot be stored, a line break breaks a log line', () => {
      expect(cleanText('a\u0000b\nc\r\nd\te\u007ff\u2028g\u2029h')).toBe('a b c d e f g h');
      expect(detailsOf(['reason'], { reason: 'x\u0000y' }, {})).toEqual({ reason: 'x y' });
      expect(detailsOf(['reason'], { reason: '\u0000\n' }, {})).toBeNull();
      expect(JSON.stringify(detailsOf(['reason', 'status'], { reason: 'a\u0000\n\u2028b', status: 'OK\u0000' }, {}))).not.toMatch(/\\u0000|\\n|\\u2028/);
    });

    it('takes a lone half of an emoji out of a text: the database refuses it, and the row would stay open', () => {
      const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

      expect(cleanText('a\ud800b')).toBe('a b');
      expect(cleanText('a\udc00b')).toBe('a b');
      expect(cleanText('\ud83d\ude00 ok')).toBe('\ud83d\ude00 ok');
      expect(cleanText('x\ud83d')).toBe('x');
      expect(detailsOf(['reason'], { reason: '\ud800' }, {})).toBeNull();
      expect(lone.test(String(detailsOf(['reason'], { reason: 'avant \udfff après' }, {})?.reason))).toBe(false);
    });

    it('cuts a text without cutting an emoji in two', () => {
      const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

      for (let pad = 0; pad < 4; pad += 1) {
        const text = `${'a'.repeat(MAX_DETAIL_LENGTH - 3 + pad)}\ud83d\ude00${'b'.repeat(40)}`;
        const cut = cutText(text, MAX_DETAIL_LENGTH);

        expect([pad, cut.length <= MAX_DETAIL_LENGTH, cut.endsWith('…'), lone.test(cut)]).toEqual([pad, true, true, false]);
        expect([pad, lone.test(String(detailsOf(['reason'], { reason: text }, {})?.reason))]).toEqual([pad, false]);
      }

      expect(cutText('short', 200)).toBe('short');
    });

    it('never keeps the value of a field that looks like a secret, even when the list asks for it', () => {
      const body = { password: 'hunter2', newPassword: 'hunter3', token: 't', otp: '123456', iban: 'TN59', status: 'A' };

      expect(detailsOf(['password', 'newPassword', 'token', 'otp', 'iban', 'status'], body, {})).toEqual({ status: 'A' });
    });

    it('recognises the names of secrets', () => {
      for (const name of ['password', 'newPassword', 'currentPassword', 'accessToken', 'refreshToken', 'otp', 'verificationCode', 'iban', 'rib', 'bankAccount', 'cardNumber', 'cvv', 'signature', 'apiKey', 'passwordHash', 'secret', 'credentials']) {
        expect([name, isSensitiveField(name)]).toEqual([name, true]);
      }

      for (const name of ['status', 'role', 'isActive', 'artisanId', 'amount', 'reason', 'visibility', 'decision', 'kind', 'method', 'type']) {
        expect([name, isSensitiveField(name)]).toEqual([name, false]);
      }
    });
  });

  describe('an id as the log writes it', () => {
    it('writes a whole number without leading zeros, and a short code as it is', () => {
      expect(canonicalId('42')).toBe('42');
      expect(canonicalId('0000042')).toBe('42');
      expect(canonicalId(42)).toBe('42');
      // the longest whole number kept has 15 digits; a longer run of digits is not an id of this server
      expect(canonicalId('123456789012345')).toBe('123456789012345');
      expect(canonicalId('0000123456789012345')).toBe('123456789012345');
      expect(canonicalId('1234567890123456')).toBeNull();
      expect(canonicalId('9'.repeat(40))).toBeNull();
    });

    it('answers null for anything else, so a text of the caller\'s choosing never reaches the table as an id', () => {
      // every id of this server is a whole number: a word, a hex or exponent form, a decimal, a uuid are not ids
      for (const value of ['', '0', '000', '-4', '1.5', '42.0', '0x2A', '1e1', '0b101', '42e0', ' 7', '7 ', '%2042', 'approved-by-ceo', 'a1b2', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '../etc', '7\u0000', 'x'.repeat(65), '<b>', null, undefined, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, {}, [], true]) {
        expect([String(value), canonicalId(value)]).toEqual([String(value), null]);
      }
    });
  });

  describe('the id of what an action created', () => {
    it('reads it at the path it is given, and nowhere else', () => {
      expect(idFromResult({ id: 12, name: 'x' }, 'id')).toBe('12');
      expect(idFromResult({ profile: { id: 5 }, user: { id: 6 }, id: 99 }, 'profile.id')).toBe('5');
      expect(idFromResult({ asset: { id: 9 }, document: { id: 4 } }, 'asset.id')).toBe('9');
      expect(idFromResult({ id: '0007' }, 'id')).toBe('7');
    });

    it('does not guess: an answer that does not have the path gives no id', () => {
      expect(idFromResult({ data: { id: 5 } }, 'id')).toBeNull();
      expect(idFromResult({ user: { id: 3 } }, 'id')).toBeNull();
      expect(idFromResult({ id: 1 }, 'profile.id')).toBeNull();
      expect(idFromResult({ profile: 'x' }, 'profile.id')).toBeNull();
    });

    it('answers null when there is none, or when it is not an id', () => {
      expect(idFromResult(null, 'id')).toBeNull();
      expect(idFromResult(undefined, 'id')).toBeNull();
      expect(idFromResult([{ id: 1 }], 'id')).toBeNull();
      expect(idFromResult('12', 'id')).toBeNull();
      expect(idFromResult({ id: 0 }, 'id')).toBeNull();
      expect(idFromResult({ id: -4 }, 'id')).toBeNull();
      expect(idFromResult({ id: 1.5 }, 'id')).toBeNull();
      expect(idFromResult({ id: {} }, 'id')).toBeNull();
      expect(idFromResult({ id: 'x'.repeat(100) }, 'id')).toBeNull();
      expect(idFromResult({ id: '' }, 'id')).toBeNull();
    });
  });

  describe('the status of an error', () => {
    it('is the one of an HTTP exception, and 500 for anything else', () => {
      expect(statusOfError(new NotFoundException())).toBe(404);
      expect(statusOfError(new HttpException('teapot', 418))).toBe(418);
      expect(statusOfError(new Error('boom'))).toBe(500);
      expect(statusOfError(null)).toBe(500);
      expect(statusOfError('text')).toBe(500);
      expect(statusOfError({ getStatus: () => 'nope' })).toBe(500);
      expect(statusOfError({ getStatus: () => 42 })).toBe(500);
    });
  });
});
