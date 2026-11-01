import { atInstantAsync } from '../../common/testing/clock';
import { buildWorld } from '../../common/testing/world';
import { ArtisansService } from './artisans.service';

/**
 * The technician starts the work with no signal and the phone sends it later (P3-06): the start is dated at the press, not at the arrival of the
 * call. The real ArtisansService on the in-memory database of the access suite.
 */
const NOW = new Date('2026-11-01T17:40:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const instant = (value: Date | null) => (value ? new Date(value.getTime()) : null);

function makeWorld(job: Record<string, unknown> = {}) {
  const w = buildWorld();
  const notifications: any = {
    sendSms: async () => ({ queued: true }),
    sendEmail: async () => ({ queued: true }),
    notify: async () => ({}),
    notifyUser: async () => ({}),
  };

  const service = new ArtisansService(w.prisma, notifications, w.svc.events, w.svc.rateLimit, w.svc.missionActions, w.svc.files);
  const row = w.memory.rows('intervention').find((entry) => entry.id === w.ids.A.intervention) as any;

  // (made long before the fixed instant of these tests: the floor under a held step is the making of the job)
  Object.assign(row, { status: 'ARRIVED', workStartedAt: null, artisanArrivedAt: ago(7200), createdAt: ago(30 * 24 * 3600), assignedAt: null, ...job });

  const events = () => w.memory.rows('interventionEvent').filter((entry) => entry.interventionId === row.id);

  return { service, job: row, artisanId: row.artisanId as number, events };
}

const start = (w: ReturnType<typeof makeWorld>, held?: number) =>
  atInstantAsync(NOW, () => w.service.startIntervention(w.artisanId, w.job.id, held));
const setOff = (w: ReturnType<typeof makeWorld>, held?: number) =>
  atInstantAsync(NOW, () => w.service.markOnTheWay(w.artisanId, w.job.id, held));
const arrive = (w: ReturnType<typeof makeWorld>, held?: number) =>
  atInstantAsync(NOW, () => w.service.markArrived(w.artisanId, w.job.id, held));

describe('starting the work when the phone held the press (P3-06)', () => {
  it('is dated at the moment of the press', async () => {
    const w = makeWorld();

    const answer: any = await start(w, 3_000);

    expect(answer.status).toBe('IN_PROGRESS');
    expect(instant(w.job.workStartedAt)).toEqual(ago(3_000));
  });

  it('is dated now when nothing was held', async () => {
    const w = makeWorld();

    await start(w);

    expect(instant(w.job.workStartedAt)).toEqual(NOW);
  });

  it('is never dated before the arrival', async () => {
    const w = makeWorld({ artisanArrivedAt: ago(1_200) });

    await start(w, 6 * 3600);

    expect(instant(w.job.workStartedAt)).toEqual(ago(1_200));
  });

  it('is never dated before the set off either, when the arrival was not written', async () => {
    const w = makeWorld({ artisanArrivedAt: null, artisanOnTheWayAt: ago(900) });

    await start(w, 6 * 3600);

    expect(instant(w.job.workStartedAt)).toEqual(ago(900));
  });

  it('sent again after a lost answer, keeps the first date', async () => {
    const w = makeWorld();

    await start(w, 3_000);

    const before = w.events().length;
    // (a different figure on the second try: had it overwritten the date, this would show)
    const again: any = await atInstantAsync(new Date(NOW.getTime() + 900_000), () => w.service.startIntervention(w.artisanId, w.job.id, 60));

    expect(again.status).toBe('IN_PROGRESS');
    expect(instant(w.job.workStartedAt)).toEqual(ago(3_000));
    expect(w.events().length).toBe(before);
  });

  it('is never dated before the job was assigned, when the road has no date to follow (a job assigned as accepted, then a start held for days)', async () => {
    const w = makeWorld({ status: 'ASSIGNED', artisanArrivedAt: null, artisanOnTheWayAt: null, artisanAcceptedAt: null, assignedAt: ago(600), createdAt: ago(1_200) });

    await start(w, 7 * 24 * 3600);

    expect(instant(w.job.workStartedAt)).toEqual(ago(600));
  });

  it('is never dated before the job was made, when it was never assigned either', async () => {
    const w = makeWorld({ status: 'ASSIGNED', artisanArrivedAt: null, artisanOnTheWayAt: null, artisanAcceptedAt: null, assignedAt: null, createdAt: ago(1_200) });

    await start(w, 7 * 24 * 3600);

    expect(instant(w.job.workStartedAt)).toEqual(ago(1_200));
  });
});

describe('setting off and arriving when the phone held the press (P3-06)', () => {
  it('setting off is dated at the moment of the press, and now when nothing was held', async () => {
    const held = makeWorld({ status: 'ARTISAN_ACCEPTED', artisanOnTheWayAt: null, artisanArrivedAt: null, artisanAcceptedAt: ago(7200) });
    const plain = makeWorld({ status: 'ARTISAN_ACCEPTED', artisanOnTheWayAt: null, artisanArrivedAt: null, artisanAcceptedAt: ago(7200) });

    await setOff(held, 1_800);
    await setOff(plain);

    expect(held.job.status).toMatch(/ON_THE_WAY$/);
    expect(instant(held.job.artisanOnTheWayAt)).toEqual(ago(1_800));
    expect(instant(plain.job.artisanOnTheWayAt)).toEqual(NOW);
  });

  it('setting off is never dated before the acceptance', async () => {
    const w = makeWorld({ status: 'ARTISAN_ACCEPTED', artisanOnTheWayAt: null, artisanArrivedAt: null, artisanAcceptedAt: ago(600) });

    await setOff(w, 6 * 3600);

    expect(instant(w.job.artisanOnTheWayAt)).toEqual(ago(600));
  });

  it('arriving is dated at the moment of the press, and now when nothing was held', async () => {
    const held = makeWorld({ status: 'ARTISAN_ON_THE_WAY', artisanArrivedAt: null, artisanOnTheWayAt: ago(7200) });
    const plain = makeWorld({ status: 'ARTISAN_ON_THE_WAY', artisanArrivedAt: null, artisanOnTheWayAt: ago(7200) });

    await arrive(held, 900);
    await arrive(plain);

    expect(held.job.status).toMatch(/ARRIVED$/);
    expect(instant(held.job.artisanArrivedAt)).toEqual(ago(900));
    expect(instant(plain.job.artisanArrivedAt)).toEqual(NOW);
  });

  it('setting off is never dated before the job was assigned, when it has no acceptance date', async () => {
    const w = makeWorld({ status: 'ARTISAN_ACCEPTED', artisanOnTheWayAt: null, artisanArrivedAt: null, artisanAcceptedAt: null, assignedAt: ago(500), createdAt: ago(900) });

    await setOff(w, 7 * 24 * 3600);

    expect(instant(w.job.artisanOnTheWayAt)).toEqual(ago(500));
  });

  it('arriving is never dated before the set off', async () => {
    const w = makeWorld({ status: 'ARTISAN_ON_THE_WAY', artisanArrivedAt: null, artisanOnTheWayAt: ago(1_200) });

    await arrive(w, 6 * 3600);

    expect(instant(w.job.artisanArrivedAt)).toEqual(ago(1_200));
  });
});
