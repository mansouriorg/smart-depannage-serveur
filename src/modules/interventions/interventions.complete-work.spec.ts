import { InterventionsService } from './interventions.service';

/**
 * POST /interventions/:id/complete-work is the route the deployed mobile app uses to close a job
 * with its "after" photo. The photo is judged and kept by the proof service (P1-07); this service
 * hands it over and then tells the dashboard and the customer.
 */

const secrets = { adminInternalNotes: 'client difficile', trackingToken: 'hash-of-the-link', cancelledById: 9 };

function makeWorld(result: Partial<{ completed: boolean; throws: Error }> = {}, customer: { locale?: string | null } | null = null) {
  const submitted: any[] = [];
  const sockets: any[] = [];
  const texts: Array<[string, string]> = [];

  const proofs: any = {
    submit: async (input: any) => {
      submitted.push(input);

      if (result.throws) throw result.throws;

      return {
        completed: result.completed ?? true,
        intervention: { id: input.interventionId, status: 'COMPLETED', client: { id: 2, name: 'Salma', phone: '+21655000000' }, ...secrets },
        view: { id: 5, kind: 'AFTER', status: 'ACCEPTED', message: 'Photo enregistrée.', photoUrl: '/api/files/9/download', receivedAt: new Date(0) },
      };
    },
  };
  const gateway: any = { sendInterventionStatus: (payload: any) => sockets.push(payload) };
  const notifications: any = { sendSms: async (to: string, text: string) => texts.push([to, text]) };
  // The customer's own language is read from their account (French when it cannot be read: an empty database stand-in).
  const prisma: any = customer ? { user: { findUnique: async ({ select }: any) => (select?.locale ? { role: 'CLIENT', locale: customer.locale } : { role: 'CLIENT' }) } } : {};
  const service = new InterventionsService(prisma, gateway, notifications, {} as any, proofs);

  return { service, submitted, sockets, texts };
}

const file = { buffer: Buffer.from('x'), mimetype: 'image/jpeg' } as any;
const capture = { latitude: '36.8', longitude: '10.18', timestamp: '2026-10-17T10:00:00Z' };

describe('completeWork (P1-07)', () => {
  it('hands the photo, the position and the closing to the proof service', async () => {
    const w = makeWorld();

    await w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture });

    expect(w.submitted.length).toBe(1);
    expect(w.submitted[0]).toMatchObject({ interventionId: 12, kind: 'AFTER', actor: { id: 7, role: 'ARTISAN' }, completeJob: true, capture });
    expect(w.submitted[0].file).toBe(file);
  });

  it('tells the dashboard and the customer, and answers without any column of the back office', async () => {
    const w = makeWorld();
    const answer: any = await w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture });

    expect(w.sockets.length).toBe(1);
    expect(w.texts.length).toBe(1);
    expect(w.texts[0][0]).toBe('+21655000000');
    expect(answer.status).toBe('COMPLETED');
    expect(answer.proof).toMatchObject({ id: 5, status: 'ACCEPTED', message: 'Photo enregistrée.' });
    expect(JSON.stringify(answer)).not.toMatch(/client difficile|hash-of-the-link|cancelledById/);
  });

  it('the text to the customer is in the language of their account (P3-04): Arabic for an Arabic one, French for the others', async () => {
    const arabic = makeWorld({}, { locale: 'ar' });
    const french = makeWorld({}, { locale: 'fr' });
    const unread = makeWorld();

    for (const w of [arabic, french, unread]) await w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture });

    expect(arabic.texts[0][1]).toBe('تم إنجاز التدخّل! حُفظ إثبات الإنجاز بأمان في طلبك. Smart-Dépannage');
    expect(french.texts[0][1]).toBe('Smart Dépannage: Votre intervention est terminée ! Une preuve sécurisée a été enregistrée sur votre dossier.');
    expect(unread.texts[0][1]).toBe(french.texts[0][1]);
  });

  it('a live event or a text message that fails does not turn a closed job into an error', async () => {
    const w = makeWorld();

    w.service['gateway'].sendInterventionStatus = () => {
      throw new Error('socket server down');
    };
    w.service['notifications'].sendSms = async () => {
      throw new Error('sms provider down');
    };

    const answer: any = await w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture });

    expect(answer.status).toBe('COMPLETED');
    expect(answer.proof.status).toBe('ACCEPTED');
  });

  it('a socket that fails does not stop the text message to the customer', async () => {
    const w = makeWorld();

    w.service['gateway'].sendInterventionStatus = () => {
      throw new Error('socket server down');
    };

    await w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture });

    expect(w.texts.length).toBe(1);
  });

  it('a photo that is refused tells nobody', async () => {
    const refusal = Object.assign(new Error('refused'), { getStatus: () => 400 });
    const w = makeWorld({ throws: refusal });

    await expect(w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture })).rejects.toThrow('refused');
    expect(w.sockets).toEqual([]);
    expect(w.texts).toEqual([]);
  });

  it('a photo that did not close the job (sent twice) is a 409 and tells nobody again', async () => {
    const w = makeWorld({ completed: false });

    let error: any;

    try {
      await w.service.completeWork(12, { id: 7, role: 'ARTISAN' as any }, { file, capture });
    } catch (caught) {
      error = caught;
    }

    expect(error.getStatus()).toBe(409);
    expect(w.sockets).toEqual([]);
    expect(w.texts).toEqual([]);
  });
});
