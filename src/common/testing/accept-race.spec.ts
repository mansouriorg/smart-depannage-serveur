import { Outcome, attempt } from './access-matrix';
import { World, buildWorld } from './world';

/**
 * Two people reach for the same mission at the same moment (P1-17). The real controllers and services run on the
 * in-memory database, whose transactions take real waits for the advisory locks (`pg_advisory_xact_lock`), so the
 * calls interleave the way they do on the server. Whoever gets there first, the answers and the job must agree:
 * one winner, a refusal for the other that says why, one line in the timeline for the one move, and a job that is
 * never in two hands. The calls are started in both orders, and once one after the other, so that each ending is seen.
 */
const ACCEPT = 'POST /artisans/me/missions/:/accept';
const SCHEDULED_ACCEPT = 'PATCH /scheduling/artisan/appointments/:/accept';
const ASSIGN = 'POST /matching/admin/interventions/:/assign/:';
const CANCEL = 'PATCH /client/interventions/:/cancel';
const TAKEN = 'Cette mission vient d’être attribuée à un autre artisan ou n’est plus disponible.';

/** Gives the calls three seconds to end: two transactions that wait for each other never would. */
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: any;

  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('still waiting after 3 s: the locks deadlocked')), 3000)))]);
  } finally {
    clearTimeout(timer);
  }
}

const open = () => ({ status: 'CREATED', artisanId: null, latitude: 36.8008, longitude: 10.1815 });

function setup(job: Record<string, unknown>) {
  const w = buildWorld();

  w.set('intervention', job);

  return { w, id: w.ids.A.intervention, A: w.ids.A.artisan, B: w.ids.B.artisan };
}

const row = (w: World, id: number) => w.memory.rows('intervention').find((entry) => entry.id === id) as any;
const lines = (w: World, id: number) => w.memory.rows('interventionEvent').filter((entry) => entry.interventionId === id).map((entry) => String(entry.type));
const accepted = (status: unknown) => ['ACCEPTED', 'ARTISAN_ACCEPTED'].includes(String(status));

const accept = (w: World, who: string, id: number) => attempt(w, w.people[who], ACCEPT, { params: { interventionId: id } });
const assign = (w: World, who: string, id: number, artisan: number) => attempt(w, w.people[who], ASSIGN, { params: { interventionId: id, artisanId: artisan }, body: {} });

/** The calls, started together, in the order given. */
const together = (calls: Array<() => Promise<Outcome>>, backwards: boolean) => within(Promise.all((backwards ? [...calls].reverse() : calls).map((call) => call())));

describe('two artisans take the same open mission (P1-17)', () => {
  for (const backwards of [false, true]) {
    it(`one gets it, the other is told it is taken, and the job is the winner's alone (${backwards ? 'second artisan first' : 'first artisan first'})`, async () => {
      const { w, id, A, B } = setup(open());
      const results = await together([() => accept(w, 'artisanA', id), () => accept(w, 'artisanB', id)], backwards);
      // the answers come back in the order the calls were started
      const callers = backwards ? [B, A] : [A, B];
      const winners = results.filter((outcome) => outcome.ok);
      const losers = results.filter((outcome) => !outcome.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].status).toBe(409);
      expect(losers[0].error.message).toBe(TAKEN);

      // the one that got a 200 is the one the job names, and the job is theirs and accepted
      expect(row(w, id).artisanId).toBe(callers[results.findIndex((outcome) => outcome.ok)]);
      expect(accepted(row(w, id).status)).toBe(true);
      expect(lines(w, id).filter((type) => type === 'ARTISAN_ACCEPTED')).toHaveLength(1);
    });
  }

  it('the artisan who lost is told nothing about the job and holds nothing of it: one acceptance, one set of messages', async () => {
    const { w, id, A, B } = setup(open());

    await together([() => accept(w, 'artisanA', id), () => accept(w, 'artisanB', id)], false);

    const loser = row(w, id).artisanId === A ? B : A;

    expect(w.memory.rows('appointment').filter((entry) => entry.interventionId === id && entry.artisanId === loser)).toHaveLength(0);
    // what the server does when a mission is accepted (tell the customer, tell the live screens) is done once, for the winner
    expect(w.sink.filter((entry) => entry === 'notifications.notifyArtisanAcceptedMission')).toHaveLength(1);
    expect(w.sink.filter((entry) => entry === 'realtime.emitStatusChange')).toHaveLength(1);
  });

  it('once it is taken, a third try is still a 409 and changes nothing', async () => {
    const { w, id, A, B } = setup(open());

    await accept(w, 'artisanA', id);

    const before = JSON.stringify(w.memory.snapshot());
    const late = await accept(w, 'artisanB', id);

    expect(late.status).toBe(409);
    expect(row(w, id).artisanId).toBe(A);
    expect(row(w, id).artisanId).not.toBe(B);
    expect(JSON.stringify(w.memory.snapshot())).toBe(before);
  });
});

describe('one artisan takes two open missions at the same moment (P1-17)', () => {
  /** A second open job in the same household, for the same artisan to reach for. */
  function twoOpenJobs(limit: number) {
    const { w, id, A } = setup(open());
    const first: any = row(w, id);
    const copy: any = { ...first };

    delete copy.id;
    copy.trackingToken = null;
    w.set('artisanProfile', { maxActiveJobs: limit });

    const second: any = w.memory.plant('intervention', copy);

    return { w, jobs: [id, second.id as number], A };
  }

  const held = (w: World, artisan: number) => w.memory.rows('intervention').filter((entry) => entry.artisanId === artisan && accepted(entry.status));

  for (const backwards of [false, true]) {
    it(`with room for one, the artisan ends with one of them and is told why for the other (${backwards ? 'second job first' : 'first job first'})`, async () => {
      const { w, jobs, A } = twoOpenJobs(1);
      const results = await together([() => accept(w, 'artisanA', jobs[0]), () => accept(w, 'artisanA', jobs[1])], backwards);

      expect(results.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(results.filter((outcome) => !outcome.ok)[0].status).toBe(400);
      expect(held(w, A)).toHaveLength(1);
      expect(lines(w, jobs[0]).concat(lines(w, jobs[1])).filter((type) => type === 'ARTISAN_ACCEPTED')).toHaveLength(1);
    });
  }

  it('the control: with room for two, both are taken', async () => {
    const { w, jobs, A } = twoOpenJobs(2);
    const results = await together([() => accept(w, 'artisanA', jobs[0]), () => accept(w, 'artisanA', jobs[1])], false);

    expect(results.every((outcome) => outcome.ok)).toBe(true);
    expect(held(w, A)).toHaveLength(2);
  });
});

describe('one artisan taps twice (P1-17)', () => {
  it('both taps are answered, the status moves once, and the timeline has one line', async () => {
    const { w, id, A } = setup({ status: 'ASSIGNED', artisanId: undefined });

    w.set('intervention', { artisanId: A });

    const [first, second] = await together([() => accept(w, 'artisanA', id), () => accept(w, 'artisanA', id)], false);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(accepted(row(w, id).status)).toBe(true);
    expect(lines(w, id).filter((type) => type === 'ARTISAN_ACCEPTED')).toHaveLength(1);
  });

  it('the mission route and the planning route at the same moment: the same one move', async () => {
    const { w, id, A } = setup({ status: 'ASSIGNED' });

    w.set('intervention', { artisanId: A });
    w.set('appointment', { status: 'SCHEDULED', artisanId: A });

    // The visit has an hour (a visit with none has nothing to confirm, P3-01); only the visit of this job: the other household has its own.
    const visit = w.memory.rows('appointment').find((entry) => entry.id === w.ids.A.appointment) as any;

    visit.startsAt = new Date(Date.now() + 24 * 3600_000);
    visit.endsAt = new Date(Date.now() + 26 * 3600_000);

    const [byMission, byPlanning] = await within(
      Promise.all([accept(w, 'artisanA', id), attempt(w, w.people.artisanA, SCHEDULED_ACCEPT, { params: { appointmentId: w.ids.A.appointment } })]),
    );

    expect(byMission.ok).toBe(true);
    expect(byPlanning.ok).toBe(true);
    expect(accepted(row(w, id).status)).toBe(true);
    expect(lines(w, id).filter((type) => type === 'ARTISAN_ACCEPTED')).toHaveLength(1);
  });
});

describe('a dispatcher gives the mission to one artisan while another accepts it (P1-17)', () => {
  for (const backwards of [false, true]) {
    it(`the job ends in one pair that makes sense, never two artisans (${backwards ? 'accept first' : 'assign first'})`, async () => {
      const { w, id, A, B } = setup(open());
      const results = await together([() => assign(w, 'dispatcher', id, B), () => accept(w, 'artisanA', id)], backwards);

      for (const outcome of results) expect([200, 409, 400]).toContain(outcome.status);

      const now = row(w, id);

      // either A took it and nobody moved it, or the dispatcher's artisan has it (assigned, or accepted by them later)
      const ends = (now.artisanId === A && accepted(now.status)) || (now.artisanId === B && String(now.status) === 'ASSIGNED');

      expect(ends).toBe(true);

      if (now.artisanId === A) expect(results.find((outcome) => outcome.status === 200)).toBeDefined();
    });
  }

  it('assigned first, then accepted by the other artisan: that artisan is told it is taken, and the dispatcher\'s choice stands', async () => {
    const { w, id, B } = setup(open());

    expect((await assign(w, 'dispatcher', id, B)).ok).toBe(true);

    const late = await accept(w, 'artisanA', id);

    expect(late.ok).toBe(false);
    expect([400, 409]).toContain(late.status);
    expect(row(w, id).artisanId).toBe(B);
    expect(String(row(w, id).status)).toBe('ASSIGNED');
  });

  it('accepted first, then given to the other artisan: the move is the dispatcher\'s to make, and the job is the other\'s', async () => {
    const { w, id, A, B } = setup(open());

    expect((await accept(w, 'artisanA', id)).ok).toBe(true);
    expect(row(w, id).artisanId).toBe(A);
    expect((await assign(w, 'dispatcher', id, B)).ok).toBe(true);
    expect(row(w, id).artisanId).toBe(B);
    expect(String(row(w, id).status)).toBe('ASSIGNED');
    expect(lines(w, id)).toEqual(['REQUEST_CREATED', 'ARTISAN_ACCEPTED', 'ARTISAN_ASSIGNED']);
  });

  it('two dispatchers give it to two artisans together: it ends with one of them, and one visit', async () => {
    const { w, id, A, B } = setup(open());
    const results = await together([() => assign(w, 'dispatcher', id, A), () => assign(w, 'admin', id, B)], false);

    for (const outcome of results) expect(outcome.ok).toBe(true);

    expect([A, B]).toContain(row(w, id).artisanId);
    expect(String(row(w, id).status)).toBe('ASSIGNED');
    expect(w.memory.rows('appointment').filter((entry) => entry.interventionId === id).length).toBeLessThanOrEqual(1);
  });
});

describe('the customer cancels while the artisan accepts (P1-17)', () => {
  for (const backwards of [false, true]) {
    it(`the job ends cancelled, and a cancelled job is never accepted (${backwards ? 'accept first' : 'cancel first'})`, async () => {
      const { w, id, A } = setup({ status: 'ASSIGNED' });

      w.set('intervention', { artisanId: A });

      const results = await together([() => attempt(w, w.people.clientA, CANCEL, { params: { id } }), () => accept(w, 'artisanA', id)], backwards);
      const cancel = backwards ? results[1] : results[0];
      const tap = backwards ? results[0] : results[1];

      expect(cancel.ok).toBe(true);
      expect(String(row(w, id).status)).toBe('CANCELLED');

      // when the cancellation came first the tap is refused and leaves no line; when the tap came first both lines are there, in that order
      if (tap.ok) expect(lines(w, id).slice(-2)).toEqual(['ARTISAN_ACCEPTED', 'CANCELLED']);
      else {
        expect([400, 409]).toContain(tap.status);
        expect(lines(w, id)).not.toContain('ARTISAN_ACCEPTED');
      }

      expect((await accept(w, 'artisanA', id)).ok).toBe(false);
      expect(String(row(w, id).status)).toBe('CANCELLED');
    });
  }
});
