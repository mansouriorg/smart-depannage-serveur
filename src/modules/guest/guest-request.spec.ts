import { createHash } from 'crypto';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';

import { fakeSubServices } from '../../common/testing/catalog';
import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { GuestService } from './guest.service';

process.env.FRONTEND_URL = 'https://www.example.tn';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type SendOptions = { userId?: number; validForMs?: number; template?: { key: string; vars?: any } };

function makeWorld(
  options: {
    smsThrows?: boolean;
    emailThrows?: boolean;
    eventsFail?: boolean;
    uploadFails?: (file: any) => Error | undefined;
  } = {},
) {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({
      name: 'Client invité',
      role: 'CLIENT',
      isActive: true,
      isGuest: false,
      deletedAt: null,
      phone: null,
      phoneKey: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
    }),
  });
  const interventions = new FakeTable({ defaults: () => ({ status: 'PENDING', photos: [], adminInternalNotes: null }) });
  const complaints = new FakeTable();

  const intervention = {
    ...interventions,
    findFirst: interventions.findFirst,
    create: async ({ data }: any) => {
      const row = interventions.insert(data);

      const owner = users.rows.find((user) => user.id === row.clientId)!;

      // the same columns as the `select` of the real query
      return {
        ...row,
        client: { id: owner.id, name: owner.name, phone: owner.phone, email: owner.email, isGuest: owner.isGuest },
        subService: null,
      };
    },
  };

  const catalog = fakeSubServices();
  const prisma: any = withTransactions({ user: users, intervention, complaint: complaints, subService: catalog }, [users, interventions, complaints]);

  const sentSms: Array<{ to: string; body: string; options?: SendOptions }> = [];
  const sentEmails: Array<{ to: string; subject: string; body: string; options?: SendOptions }> = [];
  const notifications: any = {
    sendSms: async (to: string, body: string, sendOptions?: SendOptions) => {
      if (options.smsThrows) throw new Error('gateway exploded');
      sentSms.push({ to, body, options: sendOptions });
      return { queued: true };
    },
    sendEmail: async (to: string, subject: string, body: string, sendOptions?: SendOptions) => {
      if (options.emailThrows) throw new Error('smtp exploded');
      sentEmails.push({ to, subject, body, options: sendOptions });
      return { queued: true };
    },
  };

  const events: any[] = [];
  const eventsService: any = {
    create: async (event: any) => {
      if (options.eventsFail) throw new Error('events table locked');
      events.push(event);
    },
  };

  const newRequests: any[] = [];
  const problems: any[] = [];
  const staffAlerts: any = {
    newRequest: async (request: any) => {
      newRequests.push(request);
    },
    problemReported: async (report: any) => {
      problems.push(report);
    },
  };

  const stored: Array<{ interventionId: number; clientId: number; name: string }> = [];
  const files: any = {
    uploadGuestDamagePhoto: async (target: { id: number; clientId: number }, file: any) => {
      const failure = options.uploadFails?.(file);

      // a real upload takes a moment: calls that are not kept apart overlap here
      await new Promise((resolve) => setTimeout(resolve, 1));

      if (failure) throw failure;

      stored.push({ interventionId: target.id, clientId: target.clientId, name: file.originalname });

      // like the real one: the picture is added to the request
      interventions.rows.find((row) => row.id === target.id)!.photos.push(`/files/${stored.length}/download`);

      return { id: stored.length };
    },
  };

  const createdComplaints: any[] = [];
  const complaintsService: any = {
    createComplaint: async (userId: number, role: string, interventionId: number, dto: any, complaintOptions?: any) => {
      const row = complaints.insert({ userId, interventionId, title: dto.title, description: dto.description, status: 'OPEN' });
      createdComplaints.push({ userId, role, interventionId, dto, options: complaintOptions });

      return { id: row.id, status: row.status };
    },
  };

  const rateLimit = new RateLimitService();
  const service = new GuestService(prisma, notifications, eventsService, rateLimit, staffAlerts, files, complaintsService);

  return {
    service,
    users,
    interventions,
    complaints,
    sentSms,
    sentEmails,
    events,
    newRequests,
    problems,
    stored,
    createdComplaints,
    catalog,
    prisma,
    notifications,
    eventsService,
    staffAlerts,
    files,
    complaintsService,
  };
}

type World = ReturnType<typeof makeWorld>;

let phoneCounter = 0;

/** A different number each time, so the per-number message limit does not leak between tests. */
const nextPhone = () => `2${String(1000000 + ++phoneCounter).slice(1)}`.padEnd(8, '0').slice(0, 8);

const form = (extra: Record<string, unknown> = {}) =>
  ({
    serviceType: 'PLOMBIER',
    description: 'Fuite sous évier',
    address: 'Rue de Marseille, Tunis',
    contactName: 'Sami',
    contactPhone: nextPhone(),
    ...extra,
  }) as any;

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const file = (name: string) => ({ originalname: name, mimetype: 'image/jpeg', size: 10, buffer: Buffer.from('x') }) as any;

describe('a request made without an account (P1-04)', () => {
  it('alerts the back office with the request that was created', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form());

    expect(w.newRequests.length).toBe(1);
    expect(w.newRequests[0].id).toBe((answer.intervention as any).id);
    expect(w.newRequests[0].serviceType).toBe('PLOMBIER');
  });

  it('the answer carries a link in the shape the website serves, built by the one function', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form());
    const id = (answer.intervention as any).id;

    expect(answer.trackingUrl).toBe(
      `https://www.example.tn/demande/status?id=${id}&token=${answer.rawTrackingToken}`,
    );
    expect(answer.rawTrackingToken.length).toBe(64);
  });

  it('only the hash of the token is stored, and the answer shows no staff column', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form());

    expect(w.interventions.rows[0].trackingToken).toBe(sha256(answer.rawTrackingToken));
    expect('trackingToken' in (answer.intervention as any)).toBe(false);
    expect('adminInternalNotes' in (answer.intervention as any)).toBe(false);
    expect(JSON.stringify(answer).includes(sha256(answer.rawTrackingToken))).toBe(false);
  });

  it('the same link goes by SMS and by e-mail', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form({ contactPhone: '55 111 222', contactEmail: 'sami@example.tn' }));

    expect(w.sentSms.length).toBe(1);
    expect(w.sentSms[0].to).toBe('55 111 222');
    expect(w.sentSms[0].body.includes(answer.trackingUrl)).toBe(true);
    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].to).toBe('sami@example.tn');
    expect(w.sentEmails[0].body.includes(answer.trackingUrl)).toBe(true);
    expect(w.sentEmails[0].body.startsWith('Bonjour Sami,')).toBe(true);
  });

  it('the messages use the editable templates, expire after a day and belong to the guest profile', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form({ contactEmail: 'sami2@example.tn' }));

    const sms = w.sentSms[0].options!;
    const email = w.sentEmails[0].options!;

    expect(sms.template!.key).toBe('guest.tracking_sms');
    expect(email.template!.key).toBe('guest.tracking_email');
    expect(sms.template!.vars.link).toBe(answer.trackingUrl);
    expect(email.template!.vars.link).toBe(answer.trackingUrl);
    expect(sms.validForMs).toBe(24 * 60 * 60 * 1000);
    expect(sms.userId).toBe(w.interventions.rows[0].clientId);
  });

  it('with no e-mail address typed, only the SMS goes', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form());

    expect(w.sentSms.length).toBe(1);
    expect(w.sentEmails.length).toBe(0);
  });

  it('an address that cannot receive mail is skipped, the SMS still goes', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form({ contactEmail: 'guest_1@guest.smart-depannage.local' }));

    expect(w.sentEmails.length).toBe(0);
    expect(w.sentSms.length).toBe(1);
  });

  it('a number that already got its three messages this hour: nothing is sent, the request still works', async () => {
    const w = makeWorld();
    const phone = '55 222 333';

    for (let i = 0; i < 3; i++) await w.service.createGuestIntervention(form({ contactPhone: phone }));
    const fourth = await w.service.createGuestIntervention(form({ contactPhone: phone }));

    expect(w.sentSms.length).toBe(3);
    expect(fourth.trackingUrl.startsWith('https://www.example.tn/demande/status?id=')).toBe(true);
    expect(w.interventions.rows.length).toBe(4);
  });

  it('a gateway that fails does not turn a created request into an error', async () => {
    const w = makeWorld({ smsThrows: true });

    const answer = await w.service.createGuestIntervention(form({ contactEmail: 'sami3@example.tn' }));

    expect(answer.trackingUrl.length > 0).toBe(true);
    expect(w.interventions.rows.length).toBe(1);
  });

  it('the answer does not say whose profile the request went to', async () => {
    const w = makeWorld();
    const phone = '55 777 888';

    await w.service.createGuestIntervention(form({ contactPhone: phone, contactName: 'Sami Ben Ali' }));
    const second: any = await w.service.createGuestIntervention(form({ contactPhone: phone, contactName: 'Attaquant' }));

    expect('client' in second.intervention).toBe(false);
    expect(JSON.stringify(second).includes('Sami Ben Ali')).toBe(false);
    expect(w.users.rows.length).toBe(1);
  });

  it('the answer carries no profile id either: two requests with one number cannot be told to share a profile', async () => {
    const w = makeWorld();
    const phone = '55 777 889';

    const first: any = await w.service.createGuestIntervention(form({ contactPhone: phone }));
    const second: any = await w.service.createGuestIntervention(form({ contactPhone: phone }));

    expect(w.interventions.rows[0].clientId).toBe(w.interventions.rows[1].clientId); // they do share one
    expect('clientId' in first.intervention || 'clientId' in second.intervention).toBe(false);
  });

  it('a timeline line that cannot be written does not cost the customer the alert or the link', async () => {
    const w = makeWorld({ eventsFail: true });

    const answer = await w.service.createGuestIntervention(form({ contactEmail: 'sami4@example.tn' }));

    expect(w.newRequests.length).toBe(1);
    expect(w.sentSms.length).toBe(1);
    expect(w.sentEmails.length).toBe(1);
    expect(answer.trackingUrl.length > 0).toBe(true);
  });

  it('the SMS stays in the basic SMS alphabet, so it is billed as two messages, not three', async () => {
    const w = makeWorld();
    // 7-bit alphabet of SMS: letters, digits, space and the punctuation below, a few accented letters
    const basic = /^[A-Za-z0-9 \n\r@£$¥èéùìòÇØøÅåÆæßÉÄÖÑÜäöñüà!"#%&'()*+,\-./:;<=>?_§¿¡]*$/;

    const answer = await w.service.createGuestIntervention(form({ contactName: 'Sami' }));

    expect(basic.test(w.sentSms[0].body)).toBe(true);
    expect(w.sentSms[0].body.includes(answer.trackingUrl)).toBe(true);
    expect(w.sentSms[0].body.length <= 306).toBe(true);
  });

  it('the name typed by the visitor cannot add a sentence or lines to the e-mail: it greets nobody by name instead', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(
      form({ contactName: 'Sami,\r\n\r\nVotre compte est suspendu, appelez le +216 99 999 999\n\u2028Sami', contactEmail: 'sami5@example.tn' }),
    );

    const [greeting] = w.sentEmails[0].body.split('\n');

    expect(greeting).toBe('Bonjour,');
    expect(w.sentEmails[0].body.split('\n\n')[0]).toBe(greeting);
    expect(w.sentEmails[0].options!.template!.vars.name).toBe('');
    expect(w.sentSms[0].body.includes('appelez')).toBe(false);
  });

  it('an ordinary name is used, accents and several words included', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form({ contactName: "Hélène Ben Ali-D'Or", contactEmail: 'sami9@example.tn' }));

    expect(w.sentEmails[0].body.startsWith("Bonjour Hélène Ben Ali-D'Or,")).toBe(true);
    expect(w.sentEmails[0].options!.template!.vars.name).toBe("Hélène Ben Ali-D'Or");
  });

  it('control characters in the name (NUL, escape, bell) are removed, not only line breaks', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form({ contactName: 'Sa\u0000mi\u001b\u0007 Ben', contactEmail: 'sami8@example.tn' }));

    const name = w.sentEmails[0].options!.template!.vars.name;

    expect(name).toBe('Sa mi Ben');
    expect(/[\u0000\u001b\u0007]/.test(w.sentEmails[0].body)).toBe(false);
  });

  it('a failing SMS gateway does not keep the e-mail from going out, and the other way round', async () => {
    const sms = makeWorld({ smsThrows: true });
    await sms.service.createGuestIntervention(form({ contactEmail: 'sami6@example.tn' }));
    expect(sms.sentEmails.length).toBe(1);

    const mail = makeWorld({ emailThrows: true });
    await mail.service.createGuestIntervention(form({ contactEmail: 'sami7@example.tn' }));
    expect(mail.sentSms.length).toBe(1);
  });

  it('a link written by the visitor is never stored as a photo', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form({ photos: ['https://evil.example/tracker.png'] }));

    expect(JSON.stringify(w.interventions.rows[0].photos ?? []).includes('evil')).toBe(false);
  });
});

async function newRequest(w: World, status = 'PENDING') {
  const answer = await w.service.createGuestIntervention(form());
  const id = (answer.intervention as any).id;

  w.interventions.rows.find((row) => row.id === id)!.status = status;

  return { id, token: answer.rawTrackingToken };
}

describe('photos added through the tracking link (P1-04)', () => {
  it('stores each picture on the request, for the guest profile', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    const answer = await w.service.uploadPhotos(id, token, [file('a.jpg'), file('b.jpg')]);

    expect(answer.added).toBe(2);
    expect(w.stored.map((s) => s.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(w.stored[0].interventionId).toBe(id);
    expect(w.stored[0].clientId).toBe(w.interventions.rows[0].clientId);
  });

  it('a wrong token, or the token of another request, stores nothing', async () => {
    const w = makeWorld();
    const first = await newRequest(w);
    const second = await newRequest(w);

    const wrong = await failure(w.service.uploadPhotos(first.id, 'nope', [file('a.jpg')]));
    const crossed = await failure(w.service.uploadPhotos(first.id, second.token, [file('a.jpg')]));
    const missing = await failure(w.service.uploadPhotos(first.id, undefined as any, [file('a.jpg')]));

    expect(wrong instanceof NotFoundException).toBe(true);
    expect(crossed instanceof NotFoundException).toBe(true);
    expect(missing instanceof NotFoundException).toBe(true);
    expect(w.stored.length).toBe(0);
  });

  it('no picture in the call is a 400', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    expect((await failure(w.service.uploadPhotos(id, token, []))).status).toBe(400);
    expect((await failure(w.service.uploadPhotos(id, token, undefined))).status).toBe(400);
  });

  it('more than 5 in one call is refused whole', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    const error = await failure(w.service.uploadPhotos(id, token, Array.from({ length: 6 }, (_, i) => file(`${i}.jpg`))));

    expect(error.status).toBe(400);
    expect(w.stored.length).toBe(0);
  });

  it('6 photos in all per request: the call that would go over is refused whole', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    await w.service.uploadPhotos(id, token, [file('1.jpg'), file('2.jpg'), file('3.jpg'), file('4.jpg')]);

    const error = await failure(w.service.uploadPhotos(id, token, [file('5.jpg'), file('6.jpg'), file('7.jpg')]));

    expect(error.status).toBe(400);
    expect(String(error.message).includes('2')).toBe(true);
    expect(w.stored.length).toBe(4);

    await w.service.uploadPhotos(id, token, [file('5.jpg'), file('6.jpg')]);

    expect(w.interventions.rows[0].photos.length).toBe(6);
    expect((await failure(w.service.uploadPhotos(id, token, [file('x.jpg')]))).status).toBe(400);
  });

  it('a finished or cancelled request takes no more photos; an open one does', async () => {
    for (const status of ['PENDING', 'WAITING_ADMIN_REVIEW', 'ASSIGNED', 'ARTISAN_ON_THE_WAY', 'IN_PROGRESS']) {
      const w = makeWorld();
      const { id, token } = await newRequest(w, status);

      expect((await w.service.uploadPhotos(id, token, [file('a.jpg')])).added).toBe(1);
    }

    for (const status of ['COMPLETED', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED']) {
      const w = makeWorld();
      const { id, token } = await newRequest(w, status);

      const error = await failure(w.service.uploadPhotos(id, token, [file('a.jpg')]));

      expect(error.status).toBe(403);
      expect(w.stored.length).toBe(0);
    }
  });

  it('a picture that is refused does not undo the good ones, and the answer says which', async () => {
    const w = makeWorld({
      uploadFails: (f) => (f.originalname === 'bad.jpg' ? new BadRequestException('Image illisible') : undefined),
    });
    const { id, token } = await newRequest(w);

    const answer = await w.service.uploadPhotos(id, token, [file('a.jpg'), file('bad.jpg'), file('c.jpg')]);

    expect(answer.added).toBe(2);
    expect(answer.refused).toEqual([{ position: 2, reason: 'Image illisible' }]);
  });

  it('when every picture is refused the visitor gets the refusal itself', async () => {
    const w = makeWorld({ uploadFails: () => new BadRequestException('Image illisible') });
    const { id, token } = await newRequest(w);

    const error = await failure(w.service.uploadPhotos(id, token, [file('a.jpg'), file('b.jpg')]));

    expect(error.status).toBe(400);
    expect(error.message).toBe('Image illisible');
  });

  it('a real failure (disk, database) is not hidden as a refusal', async () => {
    const w = makeWorld({ uploadFails: () => new Error('ENOSPC: no space left') });
    const { id, token } = await newRequest(w);

    const error = await failure(w.service.uploadPhotos(id, token, [file('a.jpg')]));

    expect(error.message).toBe('ENOSPC: no space left');
  });

  it('a failure of the server (a 5xx) is not hidden as a refused picture either', async () => {
    const w = makeWorld({
      uploadFails: (f) => (f.originalname === 'b.jpg' ? new HttpException('storage unavailable', 503) : undefined),
    });
    const { id, token } = await newRequest(w);

    // the first picture is fine, the second hits a server failure: the call fails, it does not "succeed with a refusal"
    const error = await failure(w.service.uploadPhotos(id, token, [file('a.jpg'), file('b.jpg')]));

    expect(error.status).toBe(503);
  });

  it('10 calls an hour per request, counted apart for each request', async () => {
    const w = makeWorld();
    const first = await newRequest(w);
    const second = await newRequest(w);

    for (let i = 0; i < 10; i++) {
      // the 6-photo cap would answer first, so each call is refused as empty: it still counts
      await failure(w.service.uploadPhotos(first.id, first.token, []));
    }

    const error = await failure(w.service.uploadPhotos(first.id, first.token, [file('a.jpg')]));

    expect(error.status).toBe(429);
    expect((await w.service.uploadPhotos(second.id, second.token, [file('a.jpg')])).added).toBe(1);
  });
});

describe('the 6-photo ceiling holds when calls arrive together (P1-04 review)', () => {
  it('ten calls of five pictures at once keep 6 photos in all, not 50', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, call) =>
        w.service
          .uploadPhotos(id, token, Array.from({ length: 5 }, (_, i) => file(`${call}-${i}.jpg`)))
          .then(() => 'stored')
          .catch((error) => `refused ${error.status}`),
      ),
    );

    expect(w.stored.length <= 6).toBe(true);
    expect(w.interventions.rows[0].photos.length <= 6).toBe(true);
    expect(outcomes.filter((outcome) => outcome === 'stored').length).toBe(1);
    expect(outcomes.filter((outcome) => outcome === 'refused 400').length).toBe(9);
  });

  it('calls on different requests do not wait for each other', async () => {
    const w = makeWorld();
    const first = await newRequest(w);
    const second = await newRequest(w);

    const [a, b] = await Promise.all([
      w.service.uploadPhotos(first.id, first.token, [file('a.jpg'), file('b.jpg')]),
      w.service.uploadPhotos(second.id, second.token, [file('c.jpg'), file('d.jpg')]),
    ]);

    expect(a.added + b.added).toBe(4);
  });
});

describe('a review does not wipe a problem that was reported (P1-04 review)', () => {
  it('leaving hasIssue out keeps a raised issue; saying false clears it', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w, 'COMPLETED');

    w.interventions.rows.find((row) => row.id === id)!.hasIssue = true;
    await w.service.submitFeedback(id, token, { rating: 4 } as any);
    expect(w.interventions.rows.find((row) => row.id === id)!.hasIssue).toBe(true);

    await w.service.submitFeedback(id, token, { rating: 4, hasIssue: false } as any);
    expect(w.interventions.rows.find((row) => row.id === id)!.hasIssue).toBe(false);
  });

  it('a review with an empty text keeps the report in the notes; a text is added after it', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w, 'COMPLETED');
    const row = w.interventions.rows.find((r) => r.id === id)!;
    row.hasIssue = true;
    row.feedbackNotes = 'Le technicien a cassé le siphon';

    await w.service.submitFeedback(id, token, { rating: 4, feedbackNotes: '' } as any);
    expect(row.feedbackNotes).toBe('Le technicien a cassé le siphon');

    await w.service.submitFeedback(id, token, { rating: 4, feedbackNotes: 'Sinon travail propre' } as any);
    expect(row.feedbackNotes).toBe('Le technicien a cassé le siphon\n\nSinon travail propre');
  });
});

describe('a problem reported through the tracking link (P1-04)', () => {
  it('opens a complaint for the guest profile, writes a timeline line and lights up the dashboard', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    const answer = await w.service.reportProblem(id, token, { title: 'Retard', description: "L'artisan n'est pas venu" });

    expect(answer.status).toBe('OPEN');
    expect(w.createdComplaints.length).toBe(1);
    expect(w.createdComplaints[0].userId).toBe(w.interventions.rows[0].clientId);
    expect(w.createdComplaints[0].role).toBe('CLIENT');
    expect(w.createdComplaints[0].interventionId).toBe(id);
    expect(w.createdComplaints[0].dto).toEqual({ title: 'Retard', description: "L'artisan n'est pas venu" });
    // the request's own notes are not replaced by an anonymous report's title
    expect(w.createdComplaints[0].options).toEqual({ keepFeedbackNotes: true });
    expect(w.events.length > 0).toBe(true);
    expect(w.events.some((e) => e.type === 'COMPLAINT_OPENED' && e.interventionId === id)).toBe(true);
    expect(w.problems).toEqual([{ interventionId: id, complaintId: answer.id, issue: "L'artisan n'est pas venu" }]);
  });

  it('without a title, the start of the text is used, cut to 120 characters', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    await w.service.reportProblem(id, token, { description: `  ${'x'.repeat(400)}  ` });

    expect(w.createdComplaints[0].dto.title).toBe('x'.repeat(120));
    expect(w.createdComplaints[0].dto.description).toBe('x'.repeat(400));
  });

  it('a wrong token opens nothing', async () => {
    const w = makeWorld();
    const first = await newRequest(w);
    const second = await newRequest(w);

    const wrong = await failure(w.service.reportProblem(first.id, 'nope', { description: 'Problème' }));
    const crossed = await failure(w.service.reportProblem(first.id, second.token, { description: 'Problème' }));

    expect(wrong instanceof NotFoundException).toBe(true);
    expect(crossed instanceof NotFoundException).toBe(true);
    expect(w.createdComplaints.length).toBe(0);
    expect(w.problems.length).toBe(0);
  });

  it('three reports a day per request, the fourth is refused with 429 and opens nothing', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    for (let i = 0; i < 3; i++) await w.service.reportProblem(id, token, { description: `Problème numéro ${i}` });

    const error = await failure(w.service.reportProblem(id, token, { description: 'Encore un' }));

    expect(error.status).toBe(429);
    expect(w.createdComplaints.length).toBe(3);
  });

  it('five complaints in all per request, even after the server restarted (counted in the database)', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);
    const clientId = w.interventions.rows[0].clientId;

    for (let i = 0; i < 5; i++) w.complaints.insert({ userId: clientId, interventionId: id, status: 'OPEN' });

    const error = await failure(w.service.reportProblem(id, token, { description: 'Un de plus' }));

    expect(error.status).toBe(429);
    expect(String(error.response?.message ?? error.message).includes('support')).toBe(true);
    expect(w.createdComplaints.length).toBe(0);
  });

  it('complaints made by others on the same request do not use up the customer\'s five', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);
    const clientId = w.interventions.rows[0].clientId;

    for (let i = 0; i < 5; i++) w.complaints.insert({ userId: clientId + 100, interventionId: id, status: 'OPEN' });

    const answer = await w.service.reportProblem(id, token, { description: 'Mon problème' });

    expect(answer.status).toBe('OPEN');
  });

  it('the limit is per request: another request can still report', async () => {
    const w = makeWorld();
    const first = await newRequest(w);
    const second = await newRequest(w);

    for (let i = 0; i < 3; i++) await w.service.reportProblem(first.id, first.token, { description: `Problème ${i}` });

    expect((await w.service.reportProblem(second.id, second.token, { description: 'Mon problème' })).status).toBe('OPEN');
  });

  it('a timeline line that cannot be written does not lose the complaint', async () => {
    const w = makeWorld();
    const { id, token } = await newRequest(w);

    (w.service as any).events = { create: async () => Promise.reject(new Error('events table locked')) };

    const answer = await w.service.reportProblem(id, token, { description: 'Mon problème' });

    expect(answer.status).toBe('OPEN');
    expect(w.problems.length).toBe(1);
  });
});

// P1-10: the sub-service is checked against the catalog before the visitor's profile is made.
describe('the sub-service of a visitor\'s request (P1-10)', () => {
  it('a sub-service of the trade asked for is kept, and the answer says whether photos are expected', async () => {
    const w = makeWorld();

    const plain: any = await w.service.createGuestIntervention(form({ subServiceId: 2 }));
    const withPhotos: any = await w.service.createGuestIntervention(form({ subServiceId: 1, contactPhone: nextPhone() }));

    expect(w.interventions.rows.map((row) => row.subServiceId)).toEqual([2, 1]);
    expect(plain.photosRequired).toBe(false);
    // the visitor's request cannot carry pictures: it is not refused for lacking them, the page asks next
    expect(withPhotos.photosRequired).toBe(true);
  });

  it('a request with no sub-service answers that no photo is expected', async () => {
    const w = makeWorld();

    const answer: any = await w.service.createGuestIntervention(form());

    expect(answer.photosRequired).toBe(false);
    expect(w.catalog.calls).toEqual([]);
  });

  it('a sub-service of another trade is a 400, and no profile, request, alert or message is made', async () => {
    const w = makeWorld();

    const error = await failure(w.service.createGuestIntervention(form({ subServiceId: 4 })));

    expect(error instanceof BadRequestException).toBe(true);
    expect(error.message).toMatch(/relève de/);
    expect(w.users.rows.length).toBe(0);
    expect(w.interventions.rows.length).toBe(0);
    expect(w.newRequests.length).toBe(0);
    expect(w.sentSms.length).toBe(0);
    expect(w.events.length).toBe(0);
  });

  it('a sub-service that does not exist or is switched off is a 400 too', async () => {
    const w = makeWorld();

    expect((await failure(w.service.createGuestIntervention(form({ subServiceId: 999 })))).getStatus()).toBe(400);
    expect((await failure(w.service.createGuestIntervention(form({ subServiceId: 3 })))).getStatus()).toBe(400);
    expect(w.users.rows.length).toBe(0);
    expect(w.interventions.rows.length).toBe(0);
  });
});
