import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { StaffAlertsService } from './staff-alerts.service';

function makeWorld(options: { socketFails?: boolean; notifyFails?: boolean; smsFails?: boolean } = {}) {
  const live: any[] = [];
  const issues: any[] = [];
  const staffNotified: number[] = [];
  const texts: Array<{ to: string; body: string }> = [];

  const gateway: any = {
    sendNewIntervention: (row: any) => {
      if (options.socketFails) throw new Error('socket server not started');
      live.push(row);
    },
    sendInterventionIssue: (payload: any) => issues.push(payload),
  };

  const notifications: any = {
    notifyNewInterventionCreated: async (id: number) => {
      if (options.notifyFails) throw new Error('database down');
      staffNotified.push(id);
    },
    sendSms: async (to: string, body: string) => {
      if (options.smsFails) throw new Error('gateway down');
      texts.push({ to, body });
    },
  };

  const service = new StaffAlertsService(gateway, notifications, new RateLimitService());

  return { service, live, issues, staffNotified, texts };
}

const request = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  serviceType: 'PLOMBIER',
  address: 'Rue de Marseille, Tunis',
  trackingToken: 'hash-of-the-token',
  ...extra,
});

function withAlertPhone<T>(phone: string | undefined, work: () => Promise<T>): Promise<T> {
  const before = process.env.ADMIN_ALERT_PHONE;

  if (phone === undefined) delete process.env.ADMIN_ALERT_PHONE;
  else process.env.ADMIN_ALERT_PHONE = phone;

  return work().finally(() => {
    if (before === undefined) delete process.env.ADMIN_ALERT_PHONE;
    else process.env.ADMIN_ALERT_PHONE = before;
  });
}

describe('a new request alerts the back office (P1-04)', () => {
  it('sends the live event to the staff and a notification to each staff member', async () => {
    const w = makeWorld();

    await withAlertPhone(undefined, () => w.service.newRequest(request(12)));

    expect(w.live.length).toBe(1);
    expect(w.live[0].id).toBe(12);
    expect(w.live[0].serviceType).toBe('PLOMBIER');
    expect(w.staffNotified).toEqual([12]);
  });

  it('never sends the hash of the tracking token to the sockets', async () => {
    const w = makeWorld();

    await withAlertPhone(undefined, () => w.service.newRequest(request(12)));

    expect('trackingToken' in w.live[0]).toBe(false);
    expect(JSON.stringify(w.live[0]).includes('hash-of-the-token')).toBe(false);
  });

  it('no text is sent while ADMIN_ALERT_PHONE is empty', async () => {
    const w = makeWorld();

    await withAlertPhone('', () => w.service.newRequest(request(12)));

    expect(w.texts).toEqual([]);
  });

  it('a text goes to the person in charge when ADMIN_ALERT_PHONE is set, with the address cut short', async () => {
    const w = makeWorld();

    await withAlertPhone('+21622000111', () => w.service.newRequest(request(12, { address: 'A'.repeat(500) })));

    expect(w.texts.length).toBe(1);
    expect(w.texts[0].to).toBe('+21622000111');
    expect(w.texts[0].body.startsWith('Alerte: Nouvelle demande (PLOMBIER) à AAAA')).toBe(true);
    expect(w.texts[0].body.length < 150).toBe(true);
  });

  it('at most 20 texts an hour for the whole server', async () => {
    const w = makeWorld();

    await withAlertPhone('+21622000111', async () => {
      for (let i = 1; i <= 30; i++) await w.service.newRequest(request(i));
    });

    expect(w.texts.length).toBe(20);
    // the dashboards and the staff notifications are not limited
    expect(w.live.length).toBe(30);
    expect(w.staffNotified.length).toBe(30);
  });

  it('each way of alerting fails alone: the others still go out and nothing is thrown', async () => {
    for (const failing of [{ socketFails: true }, { notifyFails: true }, { smsFails: true }]) {
      const w = makeWorld(failing);

      await withAlertPhone('+21622000111', () => w.service.newRequest(request(12)));

      const delivered = [w.live.length > 0, w.staffNotified.length > 0, w.texts.length > 0];

      expect(delivered.filter(Boolean).length).toBe(2);
    }
  });

  it('a problem reported by a customer reaches the dashboard, with a short excerpt', async () => {
    const w = makeWorld();

    await w.service.problemReported({ interventionId: 12, complaintId: 3, issue: 'Fuite '.repeat(200) });

    expect(w.issues.length).toBe(1);
    expect(w.issues[0].interventionId).toBe(12);
    expect(w.issues[0].complaintId).toBe(3);
    expect(w.issues[0].issue.length <= 200).toBe(true);
  });
});
