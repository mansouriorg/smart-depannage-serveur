import { LinkScenario, Scenario, SelfScenario, foreignRows, linkOf, runLink, runScenario, runSelf } from './access-matrix';
import { LINK_SCENARIOS, SCENARIOS, SELF_SCENARIOS } from './access/all';
import { hasColumn } from './memory-prisma';
import { HOUSEHOLDS, buildWorld, markStart } from './world';

/**
 * The wrong-user suite (P1-17). Each scenario calls the real controllers and services, on an in-memory database that
 * holds two households (a customer, an artisan, a job, its quote, its invoice, its messages...), as every person of
 * the server in turn. Every text of a household carries a mark (`SECRET<A:...>`). The scenario fails when:
 *
 *  - a person who should be refused is served, or a person who should be served is refused;
 *  - the answer to a person holds a mark of the other household, or a mark that the reader must never see;
 *  - a call that was refused changed a row, or a call that was served changed a row of the other household.
 *
 * `route-inventory.spec.ts` makes sure that no route is left without one. The controls at the end prove that the
 * runners can fail: a scenario that is made wrong on purpose is caught.
 */

const label = (scenario: { route: string; note?: string }, at: number) => `${scenario.route} #${at}${scenario.note ? ` (${scenario.note})` : ''}`;

describe('the wrong person, on every route that belongs to somebody', () => {
  SCENARIOS.forEach((scenario, at) => {
    it(label(scenario, at), async () => {
      expect(await runScenario(scenario)).toEqual([]);
    });
  });
});

describe('the routes that serve the caller, whoever calls', () => {
  SELF_SCENARIOS.forEach((scenario, at) => {
    it(label(scenario, at), async () => {
      expect(await runSelf(scenario)).toEqual([]);
    });
  });
});

describe('the routes that open with a tracking link', () => {
  LINK_SCENARIOS.forEach((scenario, at) => {
    it(label(scenario, at), async () => {
      expect(await runLink(scenario)).toEqual([]);
    });
  });
});

describe('the texts that nobody must see are texts that exist (controls)', () => {
  it('every text a scenario names as hidden is in the world it runs on: a mark that matches no row would pass for any answer', () => {
    const dead = new Set<string>();

    for (const scenario of [...SCENARIOS, ...SELF_SCENARIOS]) {
      if (!scenario.hidden) continue;

      const w = buildWorld();

      scenario.prepare?.(w);

      const world = JSON.stringify(w.memory.snapshot());

      for (const household of HOUSEHOLDS) {
        for (const person of Object.values(w.people)) {
          for (const hidden of scenario.hidden(household, person)) if (!hidden.startsWith('column:') && !world.includes(hidden)) dead.add(`${scenario.route}: ${hidden}`);
        }
      }
    }

    for (const scenario of LINK_SCENARIOS) {
      if (!scenario.hidden) continue;

      const w = buildWorld();

      scenario.prepare?.(w);

      const world = JSON.stringify(w.memory.snapshot());

      for (const household of HOUSEHOLDS) for (const hidden of scenario.hidden(household)) if (!hidden.startsWith('column:') && !world.includes(hidden)) dead.add(`${scenario.route}: ${hidden}`);
    }

    expect([...dead].sort()).toEqual([]);
  }, 30000);

  it('a \'column:\' entry names a column of the job', () => {
    const names = new Set<string>();

    for (const scenario of [...SCENARIOS, ...SELF_SCENARIOS]) {
      const w = buildWorld();

      for (const person of Object.values(w.people)) {
        for (const hidden of scenario.hidden?.('A', person) ?? []) if (hidden.startsWith('column:')) names.add(hidden.slice('column:'.length));
      }
    }

    for (const scenario of LINK_SCENARIOS) for (const hidden of scenario.hidden?.('A') ?? []) if (hidden.startsWith('column:')) names.add(hidden.slice('column:'.length));

    expect(names.size).toBeGreaterThan(10);
    expect([...names].filter((name) => !hasColumn('Intervention', name)).sort()).toEqual([]);
  }, 30000);
});

describe('the runners fail when a scenario is wrong (controls)', () => {
  const owner = SCENARIOS.find((scenario) => scenario.route === 'GET /interventions/:' && scenario.allowed.includes('client') && !scenario.prepare) as Scenario;

  it('the control scenario is a real one', async () => {
    expect(owner).toBeDefined();
    expect(await runScenario(owner)).toEqual([]);
  });

  it('a customer who is served although the scenario says they are not is caught', async () => {
    const problems = await runScenario({ ...owner, allowed: ['ticketStaff'] });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('clientA');
  });

  it('a person who should be served and is refused is caught', async () => {
    const problems = await runScenario({ ...owner, allowed: [...owner.allowed, 'accountant'] });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('ACCOUNTANT');
  });

  it('a mark that the reader is not to see, and does see, is caught', async () => {
    const problems = await runScenario({ ...owner, hidden: (household) => [markStart(household, 'Intervention.contactPhone')] });

    expect(problems.length).toBeGreaterThan(0);
  });

  it('a column that must not be sent is caught by its name, even when it holds nothing, and a column that is not sent is not', async () => {
    const sent = await runScenario({ ...owner, hidden: (_household, person) => (person.household ? ['column:description'] : []) });

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join('\n')).toContain('column:description');
    expect(await runScenario({ ...owner, hidden: (_household, person) => (person.household ? ['column:adminInternalNotes'] : []) })).toEqual([]);
  });

  it('a number that is somebody else\'s is caught by the scenario\'s own answer check', async () => {
    const own = SELF_SCENARIOS.find((scenario) => scenario.route === 'GET /notifications/unread/count')!;

    expect(await runSelf(own)).toEqual([]);

    const problems = await runSelf({ ...own, answer: (person) => (person.household === 'A' ? 'was told something' : null) });

    expect(problems.join('\n')).toContain('was told something');
  });

  it('a read whose answer holds nothing of the reader\'s household is caught (a scenario that would pass for any answer)', async () => {
    const problems = await runScenario({ ...owner, request: (household, world) => ({ params: { id: String(world.ids[household === 'A' ? 'B' : 'A'].intervention) } }) });

    expect(problems.length).toBeGreaterThan(0);
  });

  it('a self scenario that expects a role to be refused where it is served is caught', async () => {
    const self = SELF_SCENARIOS.find((scenario) => scenario.route === 'GET /users/me') as SelfScenario;
    const problems = await runSelf({ ...self, servedRoles: ['ARTISAN'] });

    expect(problems.length).toBeGreaterThan(0);
  });

  it('a link scenario whose call ignores the link it is given is caught: the made-up link is served', async () => {
    const link = LINK_SCENARIOS.find((scenario) => scenario.route === 'GET /guest/tracking/:') as LinkScenario;

    expect(await runLink(link)).toEqual([]);

    const problems = await runLink({ ...link, request: (household, _token, world) => link.request(household, linkOf(household), world) });

    expect(problems.length).toBeGreaterThan(0);
  });

  it('a link scenario that asks for a route that is not there says so', async () => {
    const link = LINK_SCENARIOS[0];

    expect((await runLink({ ...link, route: 'GET /nowhere/:' }))[0]).toContain('no such route');
  });

  it('a row that belongs to the other household is found by the person it points at, even when it holds no text (a row of switches)', () => {
    const world = buildWorld();
    const mine = world.people.clientA.id;
    const theirs = world.people.clientB.id;
    const change = (userId: number) => [{ table: 'notificationPreference', before: null, after: { id: 7, userId } }];

    expect(foreignRows(change(mine), 'A', world)).toEqual([]);
    expect(foreignRows(change(theirs), 'A', world)).toEqual(['notificationPreference#7 of B']);
    expect(foreignRows([{ table: 'message', before: { id: 3, senderId: theirs }, after: null }], 'A', world)).toEqual(['message#3 of B']);
    expect(foreignRows([{ table: 'quote', before: { id: 3, artisanId: world.people.artisanB.id }, after: null }], null, world)).toEqual(['quote#3 of B']);
  });
});
