import { buildWorld } from '../../common/testing/world';
import { ArtisansService } from './artisans.service';

/**
 * The technician marks a job as done (P3-04): the customer's text is written in the language of the customer's account, whatever the
 * language of the technician. The real ArtisansService on the in-memory database of the access suite, with a notifier that writes down
 * the texts it is asked to send.
 */
function makeWorld(customer: { locale?: string | null } = {}) {
  const w = buildWorld();
  const sms: Array<{ to: string; body: string }> = [];
  const notifications: any = {
    sendSms: async (to: string, body: string) => (sms.push({ to, body }), { queued: true }),
    sendEmail: async () => ({ queued: true }),
    notify: async () => ({}),
    notifyUser: async () => ({}),
  };

  const service = new ArtisansService(w.prisma, notifications, w.svc.events, w.svc.rateLimit, w.svc.missionActions, w.svc.files);
  const job = w.memory.rows('intervention').find((entry) => entry.id === w.ids.A.intervention) as any;
  const client = w.memory.rows('user').find((entry) => entry.id === job.clientId) as any;
  const artisan = w.memory.rows('user').find((entry) => entry.id === job.artisanId) as any;

  Object.assign(client, { phone: '22 123 456', ...customer });
  Object.assign(artisan, { locale: 'fr' });
  Object.assign(job, { status: 'IN_PROGRESS', afterPhotoUrl: '/files/9/download' });

  return { service, sms, job, client, artisan };
}

describe('the text to the customer when the technician marks the job as done (P3-04)', () => {
  it('an Arabic customer is texted in Arabic', async () => {
    const w = makeWorld({ locale: 'ar' });

    await w.service.completeIntervention(w.artisan.id, w.job.id);

    expect(w.sms).toEqual([{ to: '22 123 456', body: 'تم إنجاز تدخّلك. Smart-Dépannage' }]);
  });

  it('a French customer, and one whose account says nothing, are texted in French, the text they always got', async () => {
    for (const locale of ['fr', null]) {
      const w = makeWorld({ locale });

      await w.service.completeIntervention(w.artisan.id, w.job.id);

      expect(w.sms).toEqual([{ to: '22 123 456', body: 'Smart Dépannage: votre intervention est terminée.' }]);
    }
  });

  it('the language is the customer’s, not the technician’s', async () => {
    const w = makeWorld({ locale: 'fr' });

    w.artisan.locale = 'ar';
    await w.service.completeIntervention(w.artisan.id, w.job.id);

    expect(w.sms[0].body).toBe('Smart Dépannage: votre intervention est terminée.');
  });
});
