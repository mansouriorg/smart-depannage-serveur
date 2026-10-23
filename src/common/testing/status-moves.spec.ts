import { CANONICAL_STATUSES, ActorKind, TRANSITIONS, canonicalStatus } from '../../modules/intervention-workflow/intervention-status';
import { attempt, passesGuards, resolve } from './access-matrix';
import { SCENARIOS } from './access/all';
import { Person, World, buildWorld } from './world';

/**
 * No route moves a job along a road the table does not have for the person who called (P1-17).
 *
 * `transition-matrix.spec.ts` checks the table itself. This one goes through the real controllers: every scenario
 * of `access/` is run, from every one of the 16 statuses, by each person it lets in, and when the job's status
 * has changed afterwards the move must be one the table allows for that person (the customer of the job, its
 * artisan, a member of the staff) or for the system (a domain service that checked the caller itself: the payment
 * that came in, the quote that was answered). Whatever a route does behind its door, it cannot walk a job where
 * the table says nobody may. The job of the other household must not have moved at all.
 *
 * The accountant is of the back office but is not "staff" for the table: a route that lets the accountant move a
 * job fails here (it was the scheduling routes, until this ticket).
 */
const kindsOf = (person: Person): ActorKind[] => {
  if (person.household === null) return person.role === 'ACCOUNTANT' ? [] : ['staff'];

  return person.role === 'CLIENT' ? ['client'] : ['artisan'];
};

const statusOf = (world: World, id: number) => String(world.memory.rows('intervention').find((row) => row.id === id)?.status);

/** What the runs found, for the last test of the file: how many calls, which moves, by whom. */
const seen = { calls: 0, moves: 0, movers: new Set<string>() };

describe('the status of a job moves only along the table, whoever calls and whatever the route (P1-17)', () => {
  SCENARIOS.forEach((scenario, at) => {
    it(`${scenario.route} #${at}: from each of the 16 statuses, by each person it lets in`, async () => {
      const wrong: string[] = [];
      const world = buildWorld();

      scenario.prepare?.(world);

      const prepared = world.memory.snapshot();

      for (const status of CANONICAL_STATUSES) {
        world.memory.restore(prepared);
        world.set('intervention', { status });

        const base = world.memory.snapshot();
        const request = await scenario.request('A', world);

        for (const person of resolve(scenario.allowed, 'A', world)) {
          if (!passesGuards(world, scenario.route, person).ok) continue;

          world.memory.restore(base);
          world.sink.length = 0;
          seen.calls++;

          await attempt(world, person, scenario.route, request);

          const other = statusOf(world, world.ids.B.intervention);

          if (canonicalStatus(other) !== status) wrong.push(`${person.key}: the job of household B went ${status} -> ${other}`);

          const now = canonicalStatus(statusOf(world, world.ids.A.intervention));

          if (!now || now === status) continue;

          seen.moves++;
          seen.movers.add(person.household === null ? 'staff' : person.role);

          const who = ((TRANSITIONS[status] as Record<string, readonly ActorKind[]>)[now] ?? []) as readonly ActorKind[];
          const may: ActorKind[] = [...kindsOf(person), 'system'];

          if (!who.some((kind) => may.includes(kind))) wrong.push(`${person.key} (${person.role}): ${status} -> ${now} is not a move the table gives them`);
        }
      }

      expect(wrong).toEqual([]);
    }, 30000);
  });

  it('the runs above went through the routes that move jobs: customers, artisans and staff all moved one', () => {
    // run alone (`jest -t`), the tests above did not run and there is nothing to count
    if (seen.calls === 0) return;

    expect(seen.calls).toBeGreaterThan(1000);
    expect(seen.moves).toBeGreaterThan(30);
    expect([...seen.movers].sort()).toEqual(['ARTISAN', 'CLIENT', 'staff']);
  });
});
