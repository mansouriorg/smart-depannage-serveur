import { lastValueFrom, of } from 'rxjs';

import { StripStaffFieldsInterceptor } from './strip-staff-fields.interceptor';
import { stripStaffFields } from './strip-staff-fields';

describe('stripStaffFields', () => {
  it('removes staff-only keys at any depth, in objects and arrays', () => {
    const input = {
      id: 1,
      adminInternalNotes: 'secret',
      intervention: {
        id: 2,
        trackingToken: 'abc',
        client: { name: 'A' },
        payments: [{ id: 3, adminNote: 'x', amount: 10 }],
      },
    };

    expect(stripStaffFields(input)).toEqual({
      id: 1,
      intervention: {
        id: 2,
        client: { name: 'A' },
        payments: [{ id: 3, amount: 10 }],
      },
    });
  });

  it('does not mutate its input', () => {
    const input = { id: 1, adminNote: 'x' };

    stripStaffFields(input);

    expect(input).toEqual({ id: 1, adminNote: 'x' });
  });

  it('leaves dates, buffers and primitives untouched', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const buffer = Buffer.from('pdf');

    const out: any = stripStaffFields({ at: date, file: buffer, n: 5, s: 'x', nothing: null });

    expect(out.at).toBe(date);
    expect(out.file).toBe(buffer);
    expect(out.n).toBe(5);
    expect(out.s).toBe('x');
    expect(out.nothing).toBeNull();
  });

  it('does not tell who caused a notification (it may be a member of the back office)', () => {
    expect(stripStaffFields({ id: 1, actorId: 5, title: 't' })).toEqual({ id: 1, title: 't' });
  });

  it('a subtree deeper than any answer of this API is not sent, rather than sent unchecked', () => {
    let deep: any = { adminNote: 'secret' };

    for (let level = 0; level < 20; level += 1) deep = { next: deep };

    expect(JSON.stringify(stripStaffFields(deep))).not.toContain('secret');
    expect(JSON.stringify(stripStaffFields({ list: [[[[[[[[[[[[[[['secret']]]]]]]]]]]]]]] }))).not.toContain('secret');
  });

  it('keeps fields that merely contain the word admin', () => {
    expect(stripStaffFields({ adminArea: 'for the client' })).toEqual({
      adminArea: 'for the client',
    });
  });

  it('removes who at the back office decided, handled or moderated, and what they wrote for themselves (P1-08)', () => {
    // (the answer the back office gave to a request, `adminResponse`, is for the person who asked: it stays)
    const input = {
      complaint: { id: 1, adminDecisionNote: 'n', adminDecisionById: 2, refundDecidedById: 2, assignedToId: 3, assignedTo: { id: 3, email: 'a@b.tn' }, status: 'OPEN' },
      review: { id: 4, moderatedById: 2, moderationReason: 'spam', rating: 5 },
      payment: { id: 5, confirmedById: 2, refundedById: 2, createdById: 2, providerPaymentId: 'p', failureReason: 'f', refundReason: 'r', amount: 10 },
      quote: { id: 6, createdById: 2, createdBy: { id: 2, email: 'staff@x.tn' }, amountTTC: 12 },
      invoice: { id: 7, emailedTo: 'x@y.tn', cancelReason: 'c', amountTTC: 12 },
      appointment: { id: 8, scheduledById: 2, requests: [{ id: 9, reviewedById: 2, adminResponse: 'ok', status: 'PENDING' }] },
    };

    expect(stripStaffFields(input)).toEqual({
      complaint: { id: 1, status: 'OPEN' },
      review: { id: 4, rating: 5 },
      payment: { id: 5, amount: 10 },
      quote: { id: 6, amountTTC: 12 },
      invoice: { id: 7, amountTTC: 12 },
      appointment: { id: 8, requests: [{ id: 9, adminResponse: 'ok', status: 'PENDING' }] },
    });
  });

  describe('the other party\'s account (P1-08)', () => {
    const job = {
      id: 1,
      client: { id: 10, name: 'Salah', email: 'salah@x.tn', phone: '+21620000000', address: '1 rue', taxId: 'T1', website: 'w' },
      artisan: { id: 20, name: 'Ali', email: 'ali@x.tn', phone: '+21621111111' },
      messages: [{ id: 1, sender: { id: 20, name: 'Ali', email: 'ali@x.tn', role: 'ARTISAN' } }],
    };

    it('the customer reads their own account whole and the artisan without an e-mail', () => {
      expect(stripStaffFields(job, { userId: 10, role: 'CLIENT' })).toEqual({
        id: 1,
        client: job.client,
        artisan: { id: 20, name: 'Ali', phone: '+21621111111' },
        messages: [{ id: 1, sender: { id: 20, name: 'Ali', role: 'ARTISAN' } }],
      });
    });

    it('the artisan reads the customer\'s name, number and e-mail (the job is theirs) but no business detail or address, and their own account whole', () => {
      expect(stripStaffFields(job, { userId: 20, role: 'ARTISAN' })).toEqual({
        id: 1,
        client: { id: 10, name: 'Salah', email: 'salah@x.tn', phone: '+21620000000' },
        artisan: job.artisan,
        messages: [{ id: 1, sender: { id: 20, name: 'Ali', email: 'ali@x.tn', role: 'ARTISAN' } }],
      });
    });

    it('a reader that is not known, or an object that does not say whose it is, is left to the explicit views', () => {
      for (const viewer of [{}, { userId: null }, { userId: undefined, role: 'CLIENT' }]) {
        expect(stripStaffFields(job, viewer)).toEqual(job);
      }

      expect(stripStaffFields({ client: { name: 'A', email: 'a@x.tn' } }, { userId: 10 })).toEqual({
        client: { name: 'A', email: 'a@x.tn' },
      });
    });

    it('the answer to a login or a profile (the reader\'s own user, or no reader) is not touched', () => {
      const answer = { user: { id: 10, email: 'me@x.tn', address: 'Tunis', taxId: 'T', website: 'w' }, accessToken: 'a' };

      expect(stripStaffFields(answer, {})).toEqual(answer);
      expect(stripStaffFields(answer, { userId: 10, role: 'CLIENT' })).toEqual(answer);
    });

    it('keeps what is not under a person key, whoever reads', () => {
      expect(stripStaffFields({ company: { email: 'contact@sd.tn', address: 'Tunis' } }, { userId: 20 })).toEqual({
        company: { email: 'contact@sd.tn', address: 'Tunis' },
      });
      expect(stripStaffFields({ contactEmail: 'c@x.tn', email: 'me@x.tn' }, { userId: 1 })).toEqual({ contactEmail: 'c@x.tn', email: 'me@x.tn' });
    });

    it('whoever uploaded a file is a name, not an address, to somebody else', () => {
      const file = { id: 1, uploadedBy: { id: 5, name: 'Sam', role: 'SUPPORT', email: 'sam@staff.tn' } };

      expect(stripStaffFields(file, { userId: 10, role: 'CLIENT' })).toEqual({ id: 1, uploadedBy: { id: 5, name: 'Sam', role: 'SUPPORT' } });
      expect(stripStaffFields(file, { userId: 5, role: 'ARTISAN' })).toEqual(file);
    });

    it('the copies of the customer\'s details on an invoice do not go to the artisan', () => {
      const invoice = { id: 1, clientName: 'S', clientEmail: 'c@x.tn', clientPhone: '+216', clientAddress: 'a', amountTTC: 5 };

      expect(stripStaffFields({ invoice }, { userId: 20, role: 'ARTISAN' })).toEqual({ invoice: { id: 1, clientName: 'S', amountTTC: 5 } });
      expect(stripStaffFields({ invoice }, { userId: 10, role: 'CLIENT' })).toEqual({ invoice });
    });
  });
});

describe('StripStaffFieldsInterceptor', () => {
  const interceptor = new StripStaffFieldsInterceptor();

  const run = async (user: any, body: any, type = 'http') => {
    const context: any = { getType: () => type, switchToHttp: () => ({ getRequest: () => ({ user }) }) };
    const next: any = { handle: () => of(body) };

    return lastValueFrom(interceptor.intercept(context, next) as any);
  };

  const row = () => ({
    id: 1,
    adminInternalNotes: 'secret',
    client: { id: 10, name: 'Salah', email: 'salah@x.tn' },
    artisan: { id: 20, name: 'Ali', email: 'ali@x.tn' },
  });

  it('the back office gets the row as it is, whatever the role', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT']) {
      expect(await run({ id: 5, role }, row())).toEqual(row());
    }
  });

  it('a customer does not get the notes of the back office, nor the artisan\'s e-mail, and keeps their own', async () => {
    expect(await run({ id: 10, role: 'CLIENT' }, row())).toEqual({
      id: 1,
      client: { id: 10, name: 'Salah', email: 'salah@x.tn' },
      artisan: { id: 20, name: 'Ali' },
    });
  });

  it('an artisan keeps their own e-mail and the customer\'s; the reader\'s id is what tells whose account is whose', async () => {
    expect(await run({ id: 20, role: 'ARTISAN' }, row())).toEqual({
      id: 1,
      client: { id: 10, name: 'Salah', email: 'salah@x.tn' },
      artisan: { id: 20, name: 'Ali', email: 'ali@x.tn' },
    });

    // the same answer read by another artisan: the first one\'s account is somebody else\'s
    expect(await run({ id: 21, role: 'ARTISAN' }, row())).toEqual({
      id: 1,
      client: { id: 10, name: 'Salah', email: 'salah@x.tn' },
      artisan: { id: 20, name: 'Ali' },
    });
  });

  it('a visitor with no account gets nothing of the back office either', async () => {
    expect(await run(undefined, row())).toEqual({
      id: 1,
      client: { id: 10, name: 'Salah', email: 'salah@x.tn' },
      artisan: { id: 20, name: 'Ali', email: 'ali@x.tn' },
    });
  });

  it('what is not an http answer (a socket) is left alone: the sockets build their own copies', async () => {
    expect(await run({ id: 10, role: 'CLIENT' }, row(), 'ws')).toEqual(row());
  });
});
