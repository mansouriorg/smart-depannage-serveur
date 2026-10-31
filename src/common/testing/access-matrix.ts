import * as crypto from 'crypto';

import { PermissionsGuard } from '../guards/permissions.guard';
import { GuestTrackingLinkGuard } from '../../modules/guest/guest-tracking-link.guard';
import { BACK_OFFICE_ROLES, TICKET_STAFF_ROLES } from '../auth/role-policy';
import { FakeRequest } from './route-invoker';
import { Household, HOUSEHOLDS, Person, World, buildWorld, marksOf, textOfAnswer } from './world';

/**
 * The wrong-user check of a route (P1-17).
 *
 * A scenario says who may call a route and what the call is. The runner builds the server on its two
 * households, and for A and for B it makes every person of the world call the route, through the guards
 * of the route and then the controller method:
 *
 *  - who may, gets an answer (and, for a read, an answer made of the household's rows);
 *  - everybody else is refused with 401, 403 or 404, the refusal says nothing of the household, nothing
 *    is written, and nobody is told;
 *  - whoever calls, a call never changes a row of the other household.
 *
 * Every call starts from the same database, so the first call cannot change the verdict of the next
 * (a quote accepted by its owner is no longer "sent" for the stranger, who would then be refused for
 * the wrong reason).
 *
 * A route that has no id in it (`/notifications/mine`, `/users/me`) acts on the caller. Its scenario is a
 * `SelfScenario`: every person calls it, and nobody gets, or changes, a row of a household that is not theirs.
 */

export type Party = 'anyone' | 'client' | 'artisan' | 'artisans' | 'admins' | 'assigners' | 'verifiers' | 'ticketStaff' | 'accountant' | 'backOffice';

export interface Scenario {
  /** `METHOD /path/:` as `routeKey` writes it. */
  route: string;
  /** Who may make the call, for the household it is aimed at. */
  allowed: Party[];
  /** What the call is, aimed at household `h`. The caller is added by the runner. */
  request: (h: Household, w: World) => Omit<FakeRequest, 'user'> | Promise<Omit<FakeRequest, 'user'>>;
  /** Puts the world in the state the call needs (a quote that is sent, a mission that is not accepted yet...). */
  prepare?: (w: World) => void;
  /** The answer to a person who may must carry the household's rows (a read). */
  reads?: boolean;
  /**
   * Somebody who may not is answered with an empty result and not with a refusal (a list that shows only
   * what belongs to the caller). The answer still must carry nothing of the household.
   */
  emptyIsFine?: boolean;
  /**
   * Texts that a person who may call the route still must not see in the answer (the support chat of the
   * customer is not shown to the artisan of the same job). Marks of the household, or part of them.
   */
  hidden?: (household: Household, person: Person) => string[];
  /**
   * The route is a gate (a check of the role in the service) in front of work that needs more set-up than is worth
   * building here (a payout, an export): who is let in is only required not to be turned away with 401 or 403, and
   * everybody else is required to be refused, with nothing changed and nothing said.
   */
  gateOnly?: boolean;
  /**
   * Answers other than 401, 403 and 404 that also count as a refusal for this route, with the reason. The accept of
   * a mission answers 409 to an artisan who is late: the job is taken, and nothing of it is told.
   */
  alsoRefusedWith?: number[];
  /** Tables a refused call may touch (none, unless a counter of attempts is kept). */
  ignoreTables?: string[];
  /** Why the scenario is written the way it is, for the one who reads the table. */
  note?: string;
}

export interface SelfScenario {
  route: string;
  /** What the call is, for this person. */
  request?: (person: Person, w: World) => Omit<FakeRequest, 'user'> | Promise<Omit<FakeRequest, 'user'>>;
  prepare?: (w: World) => void;
  /** A customer or an artisan who calls it must get rows of their own household in the answer. */
  reads?: boolean;
  /**
   * Who is served when the guards let more in than the service serves (the route is open to every signed-in
   * account and the service answers 403 to the others): `CLIENT`, `ARTISAN`, `BACK_OFFICE` (all five staff roles) or
   * `TICKET_STAFF` (the four that work on tickets, not the accountant). Everybody else
   * who reaches the service must be refused. Left out, everybody who reaches the route is served.
   */
  servedRoles?: Array<'CLIENT' | 'ARTISAN' | 'BACK_OFFICE' | 'TICKET_STAFF'>;
  /** The back office is shown every household by this route (a list of all the complaints): its answers are not checked for the marks of the households. */
  backOfficeSeesAll?: boolean;
  /** Texts a person must not see in their own answer (marks of their household), by person. */
  hidden?: (household: Household, person: Person) => string[];
  /**
   * For an answer that holds no text to mark (a number, a row of switches): what the answer must be for this person.
   * Gives a sentence when it is not, `null` when it is right. The scenario's `prepare` makes the households differ so that
   * somebody else's answer cannot be taken for the caller's.
   */
  answer?: (person: Person, value: unknown, w: World) => string | null;
  note?: string;
}

export function resolve(parties: Party[], household: Household, world: World): Person[] {
  const found = new Set<Person>();

  for (const party of parties) {
    if (party === 'anyone') Object.values(world.people).forEach((p) => found.add(p));
    else if (party === 'client') found.add(world.people[`client${household}`]);
    else if (party === 'artisan') found.add(world.people[`artisan${household}`]);
    else if (party === 'artisans') Object.values(world.people).filter((p) => p.role === 'ARTISAN').forEach((p) => found.add(p));
    else if (party === 'verifiers') world.of(null).filter((p) => ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(p.role)).forEach((p) => found.add(p));
    else if (party === 'assigners') world.of(null).filter((p) => ['ADMIN', 'SUPER_ADMIN', 'DISPATCHER'].includes(p.role)).forEach((p) => found.add(p));
    else if (party === 'admins') world.of(null).filter((p) => p.role === 'ADMIN' || p.role === 'SUPER_ADMIN').forEach((p) => found.add(p));
    else if (party === 'ticketStaff') world.of(null).filter((p) => TICKET_STAFF_ROLES.includes(p.role as any)).forEach((p) => found.add(p));
    else if (party === 'accountant') world.of(null).filter((p) => p.role === 'ACCOUNTANT').forEach((p) => found.add(p));
    else world.of(null).filter((p) => BACK_OFFICE_ROLES.includes(p.role as any)).forEach((p) => found.add(p));
  }

  return [...found];
}

class Reflected {
  constructor(private readonly permission: string | null) {}

  getAllAndOverride() {
    return this.permission ?? undefined;
  }
}

function status(error: any): number | null {
  if (typeof error?.getStatus === 'function') return error.getStatus();
  if (typeof error?.status === 'number') return error.status;

  return null;
}

/**
 * Whether an answer shows what a scenario says must not be shown. An entry of `hidden` is a text (a mark of the world, or the
 * start of one) that must not be anywhere in the answer, or `column:<name>`: no object of the answer may have a property of that
 * name at all (a view that sends the row with the column in it, even empty, is a leak of the shape).
 */
export function showsHidden(value: unknown, hidden: string): boolean {
  if (!hidden.startsWith('column:')) return textOfAnswer(value).includes(hidden);

  const name = hidden.slice('column:'.length);
  const look = (found: unknown): boolean => {
    if (found === null || typeof found !== 'object' || found instanceof Date) return false;
    if (Array.isArray(found)) return found.some(look);

    return Object.keys(found).includes(name) || Object.values(found).some(look);
  };

  return look(value);
}

export interface Outcome {
  ok: boolean;
  value?: unknown;
  error?: any;
  status: number | null;
}

/** Whether the guards of the route let the person in (the same `PermissionsGuard` as the application, fed with the permission read from the controller). */
export function passesGuards(world: World, key: string, person: Person | null): { ok: true } | { ok: false; status: number; message: string } {
  const route = world.router.route(key);

  if (route.guards.includes('JwtAuthGuard') && !person) return { ok: false, status: 401, message: 'Unauthorized' };

  if (route.guards.includes('PermissionsGuard')) {
    const guard = new PermissionsGuard(new Reflected(route.how === 'roles' || route.how === 'class-roles' ? route.permission : null) as any);

    try {
      guard.canActivate({
        getHandler: () => null,
        getClass: () => null,
        switchToHttp: () => ({ getRequest: () => ({ user: person?.user }) }),
      } as any);
    } catch (error: any) {
      return { ok: false, status: status(error) ?? 403, message: error.message };
    }
  }

  return { ok: true };
}

/** The call of a person on a route: the guards of the route first, then the method. */
export async function attempt(world: World, person: Person | null, key: string, request: Omit<FakeRequest, 'user'>, options: { doorOpen?: boolean } = {}): Promise<Outcome> {
  // `doorOpen`: the permission of the route is not asked, as if someone had taken the @RequirePermission off; only a person who is signed in is let through
  const guards: ReturnType<typeof passesGuards> = options.doorOpen ? (person ? { ok: true } : passesGuards(world, key, person)) : passesGuards(world, key, person);

  if (!guards.ok) return { ok: false, status: guards.status, error: Object.assign(new Error(guards.message), { status: guards.status }) };

  try {
    const { value } = await world.router.call(key, { ...request, user: person?.user ?? null });

    return { ok: true, value, status: 200 };
  } catch (error) {
    return { ok: false, error, status: status(error) };
  }
}

const SIDE_EFFECT = (call: string) => !call.startsWith('rateLimit');

export interface RowChange {
  table: string;
  before: any;
  after: any;
}

/** The rows that differ between two snapshots (by id). */
export function changedRows(before: Record<string, any[]>, after: Record<string, any[]>, ignore: string[] = []): RowChange[] {
  const changes: RowChange[] = [];

  for (const table of Object.keys(after)) {
    if (ignore.includes(table)) continue;

    const was = new Map<unknown, any>((before[table] ?? []).map((row) => [row.id ?? JSON.stringify(row), row]));
    const now = new Map<unknown, any>((after[table] ?? []).map((row) => [row.id ?? JSON.stringify(row), row]));

    for (const [id, row] of now) {
      if (!was.has(id)) changes.push({ table, before: null, after: row });
      else if (JSON.stringify(was.get(id)) !== JSON.stringify(row)) changes.push({ table, before: was.get(id), after: row });
    }

    for (const [id, row] of was) if (!now.has(id)) changes.push({ table, before: row, after: null });
  }

  return changes;
}

/**
 * The columns that say whose a row is. A row with no text in it (a notification preference is only switches) has no mark
 * to find, so the person it points at says which household it belongs to.
 */
const OWNER_COLUMNS = ['userId', 'clientId', 'artisanId', 'recipientId', 'senderId', 'uploadedById', 'requestedById', 'submittedById', 'createdById'];

function householdOfUser(world: World, id: unknown): Household | null {
  if (typeof id !== 'number') return null;

  return Object.values(world.people).find((person) => person.id === id)?.household ?? null;
}

/** The marks of the households other than `own` found in the rows a call changed (before or after), and the rows that belong to them. */
export function foreignRows(changes: RowChange[], own: Household | null, world: World): string[] {
  const found: string[] = [];

  for (const change of changes) {
    const label = `${change.table}#${(change.after ?? change.before).id}`;

    for (const household of HOUSEHOLDS) {
      if (household === own) continue;

      const owned = [change.before, change.after].some((row) => row && OWNER_COLUMNS.some((column) => householdOfUser(world, (row as any)[column]) === household));

      if (marksOf(change.before, household).length > 0 || marksOf(change.after, household).length > 0 || owned) {
        found.push(`${label} of ${household}`);
      }
    }
  }

  return found;
}

/**
 * `doorOpen`: the second line. The permission of the route is not asked, as if the `@RequirePermission` had been taken off the controller,
 * and every customer and artisan the scenario does not name must still be refused by the service itself.
 */
export async function runScenario(scenario: Scenario, options: { doorOpen?: boolean } = {}): Promise<string[]> {
  const world = buildWorld();
  const problems: string[] = [];
  const say = (message: string) => problems.push(`${scenario.route}: ${message}`);

  if (!world.router.has(scenario.route)) return [`${scenario.route}: no such route`];

  scenario.prepare?.(world);

  const base = world.memory.snapshot();
  const route = world.router.route(scenario.route);
  const reaches = (person: Person) => options.doorOpen || passesGuards(world, scenario.route, person).ok;

  for (const household of HOUSEHOLDS) {
    const request = await scenario.request(household, world);
    const allowed = new Set(resolve(scenario.allowed, household, world).filter(reaches));

    for (const person of Object.values(world.people)) {
      // with the door open only the customers and the artisans are tried: the back office is kept out by the door, and by it alone, on most routes
      if (options.doorOpen && person.household === null && !allowed.has(person)) continue;

      world.memory.restore(base);
      world.sink.length = 0;

      const outcome = await attempt(world, person, scenario.route, request, options);
      const who = `${person.key} (${person.role}) on household ${household}`;
      const changes = changedRows(base, world.memory.snapshot(), scenario.ignoreTables ?? []);

      for (const foreign of foreignRows(changes, household, world)) say(`${who} changed ${foreign}`);

      if (allowed.has(person)) {
        if (scenario.gateOnly) {
          if (!outcome.ok && [401, 403].includes(outcome.status ?? 0)) say(`${who} was turned away by the gate: ${outcome.status} ${outcome.error?.message ?? outcome.error}`);
        } else if (!outcome.ok) {
          say(`${who} should be served and was refused: ${outcome.status} ${outcome.error?.message ?? outcome.error}`);
        } else if (scenario.reads && marksOf(outcome.value, household).length === 0) {
          say(`${who} was served an answer with nothing of the household in it (the scenario would pass for any answer)`);
        } else {
          for (const hidden of scenario.hidden?.(household, person) ?? []) {
            if (showsHidden(outcome.value, hidden)) say(`${who} was served ${hidden}, which is not theirs to see`);
          }
        }

        continue;
      }

      if (outcome.ok) {
        const leaked = marksOf(outcome.value, household);

        if (scenario.emptyIsFine && leaked.length === 0) {
          // Answered with nothing that belongs to the household: fine for a list.
        } else {
          say(`${who} was served${leaked.length ? ` and got ${leaked.slice(0, 3).join(', ')}` : ''}`);
        }
      } else if (![401, 403, 404, ...(scenario.alsoRefusedWith ?? [])].includes(outcome.status ?? 0)) {
        say(`${who} was answered ${outcome.status ?? 'with an error'} (${outcome.error?.message ?? outcome.error}) and not refused`);
      } else if (marksOf(outcome.error, household).length > 0) {
        say(`${who} was refused, and the refusal holds ${marksOf(outcome.error, household)[0]}`);
      }

      const touched = changes.map((change) => change.table);

      if (touched.length > 0) say(`${who} changed ${[...new Set(touched)].join(', ')}`);

      const told = world.sink.filter(SIDE_EFFECT);

      if (told.length > 0) say(`${who} made the server do ${told.slice(0, 3).join(', ')}`);
    }
  }

  void route;

  return problems;
}

/** `doorOpen`: as for `runScenario`, the roles of the route are not asked and only the customers and the artisans are tried. */
export async function runSelf(scenario: SelfScenario, options: { doorOpen?: boolean } = {}): Promise<string[]> {
  const world = buildWorld();
  const problems: string[] = [];
  const say = (message: string) => problems.push(`${scenario.route}: ${message}`);

  if (!world.router.has(scenario.route)) return [`${scenario.route}: no such route`];

  scenario.prepare?.(world);

  const base = world.memory.snapshot();

  for (const person of Object.values(world.people)) {
    if (options.doorOpen ? person.household === null : !passesGuards(world, scenario.route, person).ok) continue;

    world.memory.restore(base);
    world.sink.length = 0;

    const outcome = await attempt(world, person, scenario.route, (await scenario.request?.(person, world)) ?? {}, options);
    const who = `${person.key} (${person.role})`;

    const kinds: string[] =
      person.household === null
        ? ['BACK_OFFICE', ...(TICKET_STAFF_ROLES.includes(person.role as any) ? ['TICKET_STAFF'] : [])]
        : [person.role];

    if (scenario.servedRoles && !scenario.servedRoles.some((served) => kinds.includes(served))) {
      if (outcome.ok) say(`${who} was served a route that is not theirs`);
      else if (![401, 403, 404].includes(outcome.status ?? 0)) say(`${who} was answered ${outcome.status ?? 'with an error'} and not refused`);
      else if (HOUSEHOLDS.some((household) => marksOf(outcome.error, household).length > 0)) say(`${who} was refused and the refusal holds a text of a household`);

      for (const change of changedRows(base, world.memory.snapshot())) say(`${who} changed ${change.table}#${(change.after ?? change.before).id}`);
      continue;
    }

    if (!outcome.ok) {
      say(`${who} should be served and was refused: ${outcome.status} ${outcome.error?.message ?? outcome.error}`);
      continue;
    }

    for (const household of HOUSEHOLDS) {
      if (household === person.household) continue;
      if (scenario.backOfficeSeesAll && person.household === null) continue;

      const leaked = marksOf(outcome.value, household);

      if (leaked.length > 0) say(`${who} got ${leaked.slice(0, 3).join(', ')} of household ${household}`);
    }

    if (scenario.reads && person.household && marksOf(outcome.value, person.household).length === 0) {
      say(`${who} was served an answer with nothing of their household in it (the scenario would pass for any answer)`);
    }

    const wrongAnswer = scenario.answer?.(person, outcome.value, world);

    if (wrongAnswer) say(`${who} ${wrongAnswer}`);

    if (person.household) {
      for (const hidden of scenario.hidden?.(person.household, person) ?? []) {
        if (showsHidden(outcome.value, hidden)) say(`${who} was served ${hidden}, which is not theirs to see`);
      }
    }

    for (const foreign of foreignRows(changedRows(base, world.memory.snapshot()), person.household, world)) {
      say(`${who} changed ${foreign}`);
    }
  }

  return problems;
}

// ==========================================================================================================
// The routes that open with a link (the tracking link of a job a visitor made without an account)
// ==========================================================================================================

export interface LinkScenario {
  /** `METHOD /path/:` as `routeKey` writes it. */
  route: string;
  note?: string;
  /** Puts the world in the state the call needs (a quote that is sent, a job that is paid...). */
  prepare?: (w: World) => void;
  /** The call for the job of household `job`, holding `token` as its link (`undefined`: no link at all). */
  request: (job: Household, token: string | undefined, w: World) => Omit<FakeRequest, 'user'> | Promise<Omit<FakeRequest, 'user'>>;
  /** The answer to the holder of the right link must carry the household's rows (a read). */
  reads?: boolean;
  /** Texts the holder of the right link still must not see. */
  hidden?: (job: Household) => string[];
  /** Answers other than 401, 403 and 404 that also count as a refusal. */
  alsoRefusedWith?: number[];
  /** Calls that hold the right link of `job` and name something of household `other` (its quote, its payment): each must be refused. */
  crossed?: Array<{ what: string; request: (job: Household, other: Household, w: World) => Omit<FakeRequest, 'user'> | Promise<Omit<FakeRequest, 'user'>> }>;
}

/** The link of a household's job, as the visitor holds it (what the database keeps is its hash). */
export const linkOf = (household: Household) => `link-of-household-${household}`;
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

async function linkGuards(world: World, key: string, request: Omit<FakeRequest, 'user'>): Promise<Outcome | null> {
  if (!world.router.route(key).guards.includes('GuestTrackingLinkGuard')) return null;

  try {
    await new GuestTrackingLinkGuard(world.prisma as any).canActivate({
      switchToHttp: () => ({ getRequest: () => ({ params: request.params ?? {}, query: request.query ?? {} }) }),
    } as any);
  } catch (error) {
    return { ok: false, error, status: status(error) };
  }

  return null;
}

/**
 * A job opened by its link: the holder of the right link is served, and everybody else is refused: the link of
 * the other household's job, a made-up link, an empty one, none at all, and the right link used on another job.
 * Nobody is signed in, so the people of the world do not matter: what is tried is the link.
 */
export async function runLink(scenario: LinkScenario): Promise<string[]> {
  const world = buildWorld();
  const problems: string[] = [];
  const say = (message: string) => problems.push(`${scenario.route}: ${message}`);

  if (!world.router.has(scenario.route)) return [`${scenario.route}: no such route`];

  for (const household of HOUSEHOLDS) {
    world.set('intervention', { trackingToken: hashOf(linkOf(household)) }, world.ids[household].intervention);
  }

  scenario.prepare?.(world);

  const base = world.memory.snapshot();

  const call = async (jobOf: Household, token: string | undefined) => {
    world.memory.restore(base);
    world.sink.length = 0;

    const request = await scenario.request(jobOf, token, world);

    return (await linkGuards(world, scenario.route, request)) ?? (await attempt(world, null, scenario.route, request));
  };

  for (const job of HOUSEHOLDS) {
    const other = HOUSEHOLDS.find((household) => household !== job) as Household;

    // The right link on its own job.
    const served = await call(job, linkOf(job));

    if (!served.ok) {
      say(`the link of household ${job} should open its job and was refused: ${served.status} ${served.error?.message ?? served.error}`);
    } else {
      if (scenario.reads && marksOf(served.value, job).length === 0) say(`the link of household ${job} was served an answer with nothing of the household in it`);
      if (marksOf(served.value, other).length > 0) say(`the link of household ${job} got ${marksOf(served.value, other)[0]} of household ${other}`);

      for (const hidden of [...(scenario.hidden?.(job) ?? []), hashOf(linkOf(job)), hashOf(linkOf(other)), linkOf(job), linkOf(other)]) {
        if (showsHidden(served.value, hidden)) say(`the link of household ${job} was served ${hidden}, which is not for a visitor`);
      }

      for (const foreign of foreignRows(changedRows(base, world.memory.snapshot()), job, world)) say(`the link of household ${job} changed ${foreign}`);
    }

    // Every other link on that job, and the right link aimed at somebody else's record.
    const refuse = async (what: string, onJob: Household, missing: boolean, outcome: Outcome) => {
      const refused = [401, 403, 404, ...(missing ? [400] : []), ...(scenario.alsoRefusedWith ?? [])];

      if (outcome.ok) {
        say(`${what} was served on the job of household ${onJob}${marksOf(outcome.value, onJob).length ? ` and got ${marksOf(outcome.value, onJob)[0]}` : ''}`);
      } else if (!refused.includes(outcome.status ?? 0)) {
        say(`${what} on the job of household ${onJob} was answered ${outcome.status ?? 'with an error'} (${outcome.error?.message ?? outcome.error}) and not refused`);
      } else if (HOUSEHOLDS.some((household) => marksOf(outcome.error, household).length > 0)) {
        say(`${what} was refused on the job of household ${onJob}, and the refusal holds ${marksOf(outcome.error, onJob)[0] ?? marksOf(outcome.error, other)[0]}`);
      }

      const changed = changedRows(base, world.memory.snapshot()).map((change) => change.table);

      if (changed.length > 0) say(`${what} on the job of household ${onJob} changed ${[...new Set(changed)].join(', ')}`);

      const told = world.sink.filter(SIDE_EFFECT);

      if (told.length > 0) say(`${what} on the job of household ${onJob} made the server do ${told.slice(0, 3).join(', ')}`);
    };

    const wrong: Array<[string, Household, string | undefined, boolean]> = [
      [`the link of household ${other}`, job, linkOf(other), false],
      ['a made-up link', job, 'a-link-that-nobody-was-given', false],
      ['an empty link', job, '', true],
      ['no link', job, undefined, true],
      [`the link of household ${job} on the job of household ${other}`, other, linkOf(job), false],
    ];

    for (const [what, onJob, token, missing] of wrong) await refuse(what, onJob, missing, await call(onJob, token));

    // A job that does not exist, and a link that is wrong: the same answer, word for word (the route must not say which job numbers are in use).
    const madeUp = await call(job, 'a-link-that-nobody-was-given');
    const ghostRequest = await scenario.request(job, 'a-link-that-nobody-was-given', world);
    const ghostId = typeof ghostRequest.params?.id === 'string' ? '999999' : 999999;

    world.memory.restore(base);
    world.sink.length = 0;

    const ghostCall = { ...ghostRequest, params: { ...(ghostRequest.params ?? {}), id: ghostId } };
    const ghost = (await linkGuards(world, scenario.route, ghostCall)) ?? (await attempt(world, null, scenario.route, ghostCall));

    if (madeUp.status !== ghost.status || madeUp.error?.message !== ghost.error?.message) {
      say(`a job that does not exist is told apart from a link that is wrong (${ghost.status} “${ghost.error?.message}” and ${madeUp.status} “${madeUp.error?.message}”)`);
    }

    for (const crossed of scenario.crossed ?? []) {
      world.memory.restore(base);
      world.sink.length = 0;

      const request = await crossed.request(job, other, world);
      const outcome = (await linkGuards(world, scenario.route, request)) ?? (await attempt(world, null, scenario.route, request));

      await refuse(crossed.what, job, false, outcome);
    }
  }

  return problems;
}
