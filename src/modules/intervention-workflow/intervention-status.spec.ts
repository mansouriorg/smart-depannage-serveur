import * as fs from 'fs';
import * as path from 'path';

import {
  ActorKind,
  CANONICAL_STATUSES,
  CanonicalStatus,
  DISPATCH_SORTS,
  DISPATCH_VIEWS,
  DISPATCH_VIEW_IDS,
  LEGACY_STATUS_ALIASES,
  STATUS_GROUPS,
  STATUSES_NEEDING_ARTISAN,
  STATUSES_SET_ELSEWHERE,
  TRANSITIONS,
  actorKindFor,
  allowedNextStatuses,
  appFacingStatus,
  canonicalStatus,
  checkTransition,
  dispatchViewOf,
  initialStatus,
  isDispatchSort,
  staffMayAssign,
  staffStatusMoves,
  statusesInGroup,
  storageStatus,
  withAliases,
  VISITOR_MAY_REPORT_ISSUE_IN,
  visitorMayReportIssue,
} from './intervention-status';

const ok = (from: string, to: string, actor: ActorKind) =>
  checkTransition(from, to, actor).ok;

describe('status vocabulary', () => {
  it('maps every old spelling to the status it means', () => {
    expect(canonicalStatus('PENDING')).toBe('CREATED');
    expect(canonicalStatus('ADMIN_REVIEW')).toBe('WAITING_ADMIN_REVIEW');
    expect(canonicalStatus('ACCEPTED')).toBe('ARTISAN_ACCEPTED');
    expect(canonicalStatus('ON_THE_WAY')).toBe('ARTISAN_ON_THE_WAY');
    expect(canonicalStatus('ARRIVED')).toBe('ARTISAN_ARRIVED');
    expect(canonicalStatus('INVOICE_READY')).toBe('INVOICE_SENT');
  });

  it('keeps canonical names and rejects unknown ones', () => {
    for (const status of CANONICAL_STATUSES) {
      expect(canonicalStatus(status)).toBe(status);
    }
    expect(canonicalStatus('NOPE')).toBeNull();
    expect(canonicalStatus('')).toBeNull();
    expect(canonicalStatus(undefined)).toBeNull();
  });

  it('every alias points at a canonical status', () => {
    for (const target of Object.values(LEGACY_STATUS_ALIASES)) {
      expect((CANONICAL_STATUSES as readonly string[]).includes(target)).toBe(true);
    }
  });

  it('withAliases returns every stored spelling', () => {
    const accepted = withAliases(['ACCEPTED']);
    expect(accepted).toContain('ACCEPTED');
    expect(accepted).toContain('ARTISAN_ACCEPTED');

    const created = withAliases(['CREATED', 'COMPLETED']);
    expect(created).toContain('PENDING');
    expect(created).toContain('CREATED');
    expect(created).toContain('COMPLETED');

    expect(withAliases(['SOMETHING_ELSE'])).toEqual(['SOMETHING_ELSE']);
  });

  it('statusesInGroup covers both vocabularies', () => {
    const active = statusesInGroup('active');
    for (const name of ['ASSIGNED', 'ACCEPTED', 'ARTISAN_ACCEPTED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS', 'PAYMENT_PENDING']) {
      expect(active).toContain(name);
    }

    const waiting = statusesInGroup('waiting');
    for (const name of ['PENDING', 'CREATED', 'ADMIN_REVIEW', 'WAITING_ADMIN_REVIEW', 'QUOTE_SENT']) {
      expect(waiting).toContain(name);
    }

    expect(statusesInGroup('completed')).toContain('INVOICE_READY');
    expect(statusesInGroup('completed')).toContain('INVOICE_SENT');
  });

  it('the groups cover every status exactly once', () => {
    const all = Object.values(STATUS_GROUPS).flat() as string[];
    expect(all.length).toBe(CANONICAL_STATUSES.length);
    expect(new Set(all).size).toBe(all.length);
    for (const status of CANONICAL_STATUSES) {
      expect(all).toContain(status);
    }
  });

  it('keeps the spelling the caller used until STATUS_STORAGE=canonical', () => {
    expect(storageStatus('PENDING', '')).toBe('PENDING');
    expect(storageStatus('ACCEPTED', '')).toBe('ACCEPTED');
    expect(storageStatus('ACCEPTED', 'legacy')).toBe('ACCEPTED');
    expect(storageStatus('ACCEPTED', 'canonical')).toBe('ARTISAN_ACCEPTED');
    expect(storageStatus('PENDING', 'CANONICAL')).toBe('CREATED');
    expect(storageStatus('QUOTE_SENT', 'canonical')).toBe('QUOTE_SENT');
    expect(storageStatus('NOT_A_STATUS', 'canonical')).toBe('NOT_A_STATUS');
  });

  it('a new request starts as PENDING until the switch, then CREATED', () => {
    expect(initialStatus('')).toBe('PENDING');
    expect(initialStatus('legacy')).toBe('PENDING');
    expect(initialStatus('canonical')).toBe('CREATED');
  });
});

describe('transition table', () => {
  it('has a row for every status and only canonical targets', () => {
    for (const from of CANONICAL_STATUSES) {
      expect(TRANSITIONS[from]).toBeDefined();
      for (const to of Object.keys(TRANSITIONS[from])) {
        expect((CANONICAL_STATUSES as readonly string[]).includes(to)).toBe(true);
        expect(to === from).toBe(false);
      }
    }
  });

  it('terminal statuses have no way out except the dispute reopening', () => {
    expect(allowedNextStatuses('CANCELLED')).toEqual([]);
    expect(allowedNextStatuses('DISPUTED', 'artisan')).toEqual([]);
    expect(allowedNextStatuses('DISPUTED', 'staff')).toEqual(['WAITING_ADMIN_REVIEW', 'CANCELLED']);
  });

  it('only staff or an automatic process can confirm a payment or an invoice', () => {
    for (const from of CANONICAL_STATUSES) {
      for (const to of ['PAID', 'INVOICE_SENT'] as CanonicalStatus[]) {
        const who = TRANSITIONS[from][to] ?? [];
        expect(who.includes('artisan')).toBe(false);
        expect(who.includes('client')).toBe(false);
      }
    }
  });

  it('an artisan can never cancel a job', () => {
    for (const from of CANONICAL_STATUSES) {
      const who = TRANSITIONS[from].CANCELLED ?? [];
      expect(who.includes('artisan')).toBe(false);
    }
  });

  it('staff can reach every status the others can reach', () => {
    for (const from of CANONICAL_STATUSES) {
      for (const to of Object.keys(TRANSITIONS[from]) as CanonicalStatus[]) {
        const who = TRANSITIONS[from][to] as readonly ActorKind[];
        expect(who.includes('staff')).toBe(true);
      }
    }
  });
});

describe('the whole happy path, by the right people', () => {
  const steps: Array<[string, string, ActorKind]> = [
    ['CREATED', 'WAITING_ADMIN_REVIEW', 'system'],
    ['WAITING_ADMIN_REVIEW', 'QUOTE_SENT', 'staff'],
    ['QUOTE_SENT', 'QUOTE_ACCEPTED', 'client'],
    ['QUOTE_ACCEPTED', 'ASSIGNED', 'staff'],
    ['ASSIGNED', 'ARTISAN_ACCEPTED', 'artisan'],
    ['ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'artisan'],
    ['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'artisan'],
    ['ARTISAN_ARRIVED', 'IN_PROGRESS', 'artisan'],
    ['IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'artisan'],
    ['WAITING_CLIENT_VALIDATION', 'COMPLETED', 'client'],
    ['COMPLETED', 'PAYMENT_PENDING', 'client'],
    ['PAYMENT_PENDING', 'PAID', 'staff'],
    ['PAID', 'INVOICE_SENT', 'staff'],
  ];

  it.each(steps.map((s) => s.join(' ')))('%s', (label: string) => {
    const [from, to, actor] = label.split(' ');
    expect(ok(from, to, actor as ActorKind)).toBe(true);
  });
});

describe('what the deployed apps do today keeps working', () => {
  it('admin dropdown and artisan screen with the old spellings', () => {
    expect(ok('PENDING', 'ACCEPTED', 'staff')).toBe(true); // assign from the admin
    expect(ok('PENDING', 'ACCEPTED', 'artisan')).toBe(true); // take an open job
    expect(ok('ACCEPTED', 'IN_PROGRESS', 'artisan')).toBe(true); // mobile "start"
    expect(ok('ACCEPTED', 'IN_PROGRESS', 'staff')).toBe(true);
    expect(ok('IN_PROGRESS', 'COMPLETED', 'artisan')).toBe(true); // proof upload
    expect(ok('PENDING', 'CANCELLED', 'staff')).toBe(true);
    expect(ok('ACCEPTED', 'CANCELLED', 'staff')).toBe(true);
    expect(ok('IN_PROGRESS', 'CANCELLED', 'staff')).toBe(true);
    expect(ok('ON_THE_WAY', 'ARRIVED', 'artisan')).toBe(true);
  });

  it('a client can still cancel before the work starts', () => {
    expect(ok('PENDING', 'CANCELLED', 'client')).toBe(true);
    expect(ok('ADMIN_REVIEW', 'CANCELLED', 'client')).toBe(true);
    expect(ok('ASSIGNED', 'CANCELLED', 'client')).toBe(true);
  });
});

describe('what is refused', () => {
  it('jumps over the workflow', () => {
    expect(checkTransition('CREATED', 'PAID', 'staff')).toEqual({
      ok: false,
      reason: 'not_allowed',
      message: 'Transition non autorisée: CREATED -> PAID.',
    });
    expect(ok('PENDING', 'COMPLETED', 'staff')).toBe(false);
    expect(ok('COMPLETED', 'IN_PROGRESS', 'staff')).toBe(false);
    expect(ok('ASSIGNED', 'ARTISAN_ARRIVED', 'artisan')).toBe(false);
    expect(ok('ARTISAN_ACCEPTED', 'COMPLETED', 'artisan')).toBe(false);
  });

  it('nothing leaves a cancelled job', () => {
    for (const to of CANONICAL_STATUSES) {
      if (to === 'CANCELLED') continue;
      expect(ok('CANCELLED', to, 'staff')).toBe(false);
    }
  });

  it('an invoiced job can still be paid (invoice first, transfer later) or disputed', () => {
    expect(allowedNextStatuses('INVOICE_SENT', 'staff')).toEqual(['PAID', 'DISPUTED']);
    expect(ok('INVOICE_SENT', 'PAID', 'system')).toBe(true);
    expect(ok('INVOICE_SENT', 'PAID', 'artisan')).toBe(false);
    expect(ok('INVOICE_SENT', 'COMPLETED', 'staff')).toBe(false);
    expect(ok('INVOICE_SENT', 'CANCELLED', 'staff')).toBe(false);
  });

  it('an artisan can report a problem until the job is closed, not before it exists', () => {
    for (const from of ['WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT']) {
      expect(ok(from, 'DISPUTED', 'artisan')).toBe(true);
      expect(ok(from, 'DISPUTED', 'client')).toBe(true);
    }
    expect(ok('CREATED', 'DISPUTED', 'artisan')).toBe(false);
  });

  it('staff can hand a started job to another artisan, the artisan can step back while on the way', () => {
    for (const from of ['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS']) {
      expect(ok(from, 'ARTISAN_ACCEPTED', 'staff')).toBe(true);
      expect(ok(from, 'ARTISAN_ACCEPTED', 'artisan')).toBe(false);
    }
    expect(ok('ARTISAN_ON_THE_WAY', 'WAITING_ADMIN_REVIEW', 'artisan')).toBe(true);
    expect(ok('ARTISAN_ARRIVED', 'WAITING_ADMIN_REVIEW', 'artisan')).toBe(true);
    expect(ok('QUOTE_SENT', 'ARTISAN_ACCEPTED', 'staff')).toBe(true);
  });

  it('the right move by the wrong person is a different error', () => {
    const verdict = checkTransition('IN_PROGRESS', 'COMPLETED', 'client');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('wrong_actor');

    expect(ok('COMPLETED', 'PAID', 'artisan')).toBe(false);
    expect(ok('COMPLETED', 'PAID', 'client')).toBe(false);
    expect(ok('QUOTE_SENT', 'ASSIGNED', 'client')).toBe(false);
    expect(ok('WAITING_ADMIN_REVIEW', 'ARTISAN_ACCEPTED', 'client')).toBe(false);
  });

  it('unknown statuses', () => {
    const verdict = checkTransition('CREATED', 'FLYING', 'staff');
    expect(verdict.ok === false && verdict.reason).toBe('unknown_status');
    const other = checkTransition('FLYING', 'CREATED', 'staff');
    expect(other.ok === false && other.reason).toBe('unknown_status');
  });

  it('staying where you are is not a move', () => {
    const same = checkTransition('ASSIGNED', 'ASSIGNED', 'staff');
    expect(same.ok && same.same).toBe(true);
    const sameAliases = checkTransition('ACCEPTED', 'ARTISAN_ACCEPTED', 'artisan');
    expect(sameAliases.ok && sameAliases.same).toBe(true);
  });
});

describe('allowedNextStatuses', () => {
  it('lists what each kind of actor may do next', () => {
    expect(allowedNextStatuses('PENDING', 'artisan')).toEqual(['ARTISAN_ACCEPTED']);
    expect(allowedNextStatuses('ARTISAN_ARRIVED', 'client')).toEqual(['CANCELLED', 'DISPUTED']);
    expect(allowedNextStatuses('IN_PROGRESS', 'artisan')).toEqual(['WAITING_CLIENT_VALIDATION', 'COMPLETED', 'DISPUTED']);
    expect(allowedNextStatuses('ARTISAN_ARRIVED', 'artisan')).toEqual(['IN_PROGRESS', 'WAITING_ADMIN_REVIEW', 'DISPUTED']);
    expect(allowedNextStatuses('nothing')).toEqual([]);
  });

  it('without an actor, lists every legal target', () => {
    expect(allowedNextStatuses('PAID')).toEqual(['INVOICE_SENT', 'DISPUTED']);
  });

  it('leaves out the statuses that need an artisan when nobody is assigned', () => {
    expect(allowedNextStatuses('CREATED', 'staff')).toEqual([
      'WAITING_ADMIN_REVIEW',
      'QUOTE_SENT',
      'ASSIGNED',
      'ARTISAN_ACCEPTED',
      'CANCELLED',
    ]);
    expect(allowedNextStatuses('CREATED', 'staff', { hasArtisan: false })).toEqual([
      'WAITING_ADMIN_REVIEW',
      'QUOTE_SENT',
      'CANCELLED',
    ]);
    expect(allowedNextStatuses('CREATED', 'staff', { hasArtisan: true })).toEqual(
      allowedNextStatuses('CREATED', 'staff'),
    );
  });
});

describe('actorKindFor', () => {
  const job = { clientId: 10, artisanId: 20 };

  it('works out who the caller is for this job', () => {
    expect(actorKindFor({ id: 1, role: 'ADMIN' }, job)).toBe('staff');
    expect(actorKindFor({ id: 1, role: 'DISPATCHER' }, job)).toBe('staff');
    expect(actorKindFor({ id: 1, role: 'SUPPORT' }, job)).toBe('staff');
    expect(actorKindFor({ id: 20, role: 'ARTISAN' }, job)).toBe('artisan');
    expect(actorKindFor({ id: 10, role: 'CLIENT' }, job)).toBe('client');
  });

  it('strangers and the accountant get nothing', () => {
    expect(actorKindFor({ id: 99, role: 'ARTISAN' }, job)).toBeNull();
    expect(actorKindFor({ id: 99, role: 'CLIENT' }, job)).toBeNull();
    expect(actorKindFor({ id: 5, role: 'ACCOUNTANT' }, job)).toBeNull();
    expect(actorKindFor({ id: 20, role: 'CLIENT' }, job)).toBeNull();
    expect(actorKindFor({ id: 20, role: 'ARTISAN' }, { clientId: 10, artisanId: null })).toBeNull();
  });
});

describe('the statuses in which a visitor may report a problem (P1-09)', () => {
  it('are the ones in which an artisan is on the job, in either spelling', () => {
    for (const status of ['ARTISAN_ACCEPTED', 'ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS']) {
      expect(visitorMayReportIssue(status)).toBe(true);
    }

    for (const status of ['CREATED', 'PENDING', 'WAITING_ADMIN_REVIEW', 'QUOTE_SENT', 'ASSIGNED', 'WAITING_CLIENT_VALIDATION', 'PAYMENT_PENDING', 'COMPLETED', 'PAID', 'CANCELLED', 'DISPUTED', 'NOPE', '', null, undefined]) {
      expect(visitorMayReportIssue(status)).toBe(false);
    }
  });

  it('is one list: the service reads it, it is not written out a second time', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'interventions', 'interventions.service.ts'), 'utf8');

    expect(service).toContain('withAliases(VISITOR_MAY_REPORT_ISSUE_IN)');
    expect(service).not.toMatch(/withAliases\(\[[^\]]*ARTISAN_ARRIVED/);
    expect([...VISITOR_MAY_REPORT_ISSUE_IN]).toEqual(['ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS']);
  });
});

describe('the dispatcher\'s tabs (P1-13)', () => {
  it('put every status in exactly one tab, so that no job falls out of the queue', () => {
    const seen = new Map<string, string[]>();

    for (const view of DISPATCH_VIEWS) {
      for (const status of view.statuses) {
        seen.set(status, [...(seen.get(status) ?? []), view.id]);
      }
    }

    for (const status of CANONICAL_STATUSES) {
      expect(`${status}: ${(seen.get(status) ?? []).join(',')}`).toMatch(new RegExp(`^${status}: [A-Za-z]+$`));
    }

    expect([...seen.keys()].sort()).toEqual([...CANONICAL_STATUSES].sort());
  });

  it('have an id, a label in French and statuses each, with ids nobody else could mistake', () => {
    expect(DISPATCH_VIEW_IDS).toEqual(['toAssign', 'quote', 'active', 'done', 'cancelled', 'disputed']);
    expect(new Set(DISPATCH_VIEW_IDS).size).toBe(DISPATCH_VIEWS.length);

    for (const view of DISPATCH_VIEWS) {
      expect(view.label.length).toBeGreaterThan(2);
      expect(view.statuses.length).toBeGreaterThan(0);
    }
  });

  it('"to assign" is the jobs a dispatcher can give to somebody and that nobody has yet', () => {
    const toAssign = dispatchViewOf('toAssign');

    expect([...(toAssign?.statuses ?? [])]).toEqual(['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_ACCEPTED']);

    for (const status of toAssign?.statuses ?? []) {
      expect(staffMayAssign(status)).toBe(true);
      expect(STATUSES_NEEDING_ARTISAN).not.toContain(status);
    }
  });

  it('"in progress" is where an artisan has the job and it is not finished', () => {
    const active = dispatchViewOf('active');

    for (const status of active?.statuses ?? []) {
      expect(STATUSES_NEEDING_ARTISAN).toContain(status);
    }

    expect(active?.statuses).not.toContain('COMPLETED');
    expect(active?.statuses).not.toContain('CANCELLED');
  });

  it('dispatchViewOf: a tab by its id, and nothing for a made-up one', () => {
    expect(dispatchViewOf('done')?.label).toBe('Terminées');
    expect(dispatchViewOf('everything')).toBeUndefined();
    expect(dispatchViewOf('')).toBeUndefined();
    expect(dispatchViewOf(undefined)).toBeUndefined();
    expect(dispatchViewOf(null)).toBeUndefined();
    expect(dispatchViewOf('constructor')).toBeUndefined();
  });

  it('the orders are three, and anything else is no order', () => {
    expect([...DISPATCH_SORTS]).toEqual(['queue', 'newest', 'oldest']);

    for (const sort of DISPATCH_SORTS) expect(isDispatchSort(sort)).toBe(true);
    for (const sort of ['', 'urgency', 'QUEUE', undefined, null, 3, {}]) expect(isDispatchSort(sort)).toBe(false);
  });
});

describe('staffMayAssign (P1-13)', () => {
  it('is true while a job can be given to an artisan, or to another one', () => {
    for (const status of ['CREATED', 'PENDING', 'WAITING_ADMIN_REVIEW', 'ADMIN_REVIEW', 'QUOTE_ACCEPTED', 'ASSIGNED', 'ARTISAN_ACCEPTED', 'ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS']) {
      expect(`${status}: ${staffMayAssign(status)}`).toBe(`${status}: true`);
    }
  });

  it('is false once the work is done, cancelled, disputed, or unknown, and while a quote is out', () => {
    for (const status of ['QUOTE_SENT', 'WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'INVOICE_READY', 'CANCELLED', 'DISPUTED', 'NOPE', '']) {
      expect(`${status}: ${staffMayAssign(status)}`).toBe(`${status}: false`);
    }
  });

  it('follows the table (the move to ASSIGNED that staff may make), except while a quote is out', () => {
    for (const status of CANONICAL_STATUSES) {
      expect(`${status}: ${staffMayAssign(status)}`).toBe(
        `${status}: ${status === 'QUOTE_SENT' ? false : checkTransition(status, 'ASSIGNED', 'staff').ok}`,
      );
    }
  });
});

describe('staffStatusMoves: what the status menu offers (P1-13)', () => {
  const moves = (status: string, hasArtisan: boolean) => staffStatusMoves(status, { hasArtisan });

  it('a request nobody has: cancel it, send it to the back office\'s review, or open a dispute', () => {
    expect(moves('CREATED', false)).toEqual(['WAITING_ADMIN_REVIEW', 'CANCELLED']);
    expect(moves('PENDING', false)).toEqual(['WAITING_ADMIN_REVIEW', 'CANCELLED']);
    expect(moves('WAITING_ADMIN_REVIEW', false)).toEqual(['CANCELLED', 'DISPUTED']);
    expect(moves('QUOTE_ACCEPTED', false)).toEqual(['CANCELLED', 'DISPUTED']);
  });

  it('never offers ASSIGNED: giving the job to somebody is the assignment, with its checks', () => {
    for (const status of CANONICAL_STATUSES) {
      for (const hasArtisan of [true, false]) {
        expect(moves(status, hasArtisan)).not.toContain('ASSIGNED');
      }
    }
  });

  it('a job an artisan has: the next steps of the visit, a cancellation, a dispute', () => {
    expect(moves('ASSIGNED', true)).toEqual(['ARTISAN_ACCEPTED', 'IN_PROGRESS', 'CANCELLED', 'DISPUTED']);
    expect(moves('ARTISAN_ACCEPTED', true)).toEqual(['ARTISAN_ON_THE_WAY', 'IN_PROGRESS', 'CANCELLED', 'DISPUTED']);
    expect(moves('ARTISAN_ON_THE_WAY', true)).toEqual(['ARTISAN_ARRIVED', 'IN_PROGRESS', 'CANCELLED', 'DISPUTED']);
    expect(moves('ARTISAN_ARRIVED', true)).toEqual(['IN_PROGRESS', 'CANCELLED', 'DISPUTED']);
    expect(moves('IN_PROGRESS', true)).toEqual(['WAITING_CLIENT_VALIDATION', 'COMPLETED', 'CANCELLED', 'DISPUTED']);
    expect(moves('WAITING_CLIENT_VALIDATION', true)).toEqual(['COMPLETED', 'CANCELLED', 'DISPUTED']);
  });

  it('the old spellings give the same menu', () => {
    expect(moves('ACCEPTED', true)).toEqual(moves('ARTISAN_ACCEPTED', true));
    expect(moves('ON_THE_WAY', true)).toEqual(moves('ARTISAN_ON_THE_WAY', true));
    expect(moves('ARRIVED', true)).toEqual(moves('ARTISAN_ARRIVED', true));
    expect(moves('ADMIN_REVIEW', false)).toEqual(moves('WAITING_ADMIN_REVIEW', false));
  });

  it('never takes a job "back to review" while an artisan still has it (give it to another artisan instead), except a dispute', () => {
    for (const status of CANONICAL_STATUSES.filter((status) => status !== 'DISPUTED')) {
      expect(`${status}: ${moves(status, true).includes('WAITING_ADMIN_REVIEW')}`).toBe(`${status}: false`);
    }

    // The technician did the work: reopening the dispute for review is how it is settled.
    expect(moves('DISPUTED', true)).toEqual(['WAITING_ADMIN_REVIEW', 'CANCELLED']);
    expect(moves('DISPUTED', false)).toEqual(['WAITING_ADMIN_REVIEW', 'CANCELLED']);
  });

  it('"accepted by the technician" is offered from ASSIGNED only: later it is a step backwards, earlier it skips the assignment', () => {
    for (const status of CANONICAL_STATUSES.filter((status) => status !== 'ASSIGNED')) {
      for (const hasArtisan of [true, false]) {
        expect(`${status}/${hasArtisan}: ${moves(status, hasArtisan).includes('ARTISAN_ACCEPTED')}`).toBe(`${status}/${hasArtisan}: false`);
      }
    }

    expect(moves('ASSIGNED', true)).toContain('ARTISAN_ACCEPTED');
  });

  it('a quote that is out: back to review or cancel, nothing that would leave the quote saying the opposite', () => {
    expect(moves('QUOTE_SENT', false)).toEqual(['WAITING_ADMIN_REVIEW', 'CANCELLED', 'DISPUTED']);
    expect(moves('QUOTE_SENT', false)).not.toContain('QUOTE_ACCEPTED');
  });

  it('leaves the money and the quote to their own screens', () => {
    expect(moves('COMPLETED', true)).toEqual(['DISPUTED']);
    expect(moves('PAYMENT_PENDING', true)).toEqual(['DISPUTED']);
    expect(moves('PAID', true)).toEqual(['DISPUTED']);
    expect(moves('INVOICE_SENT', true)).toEqual(['DISPUTED']);
    expect(moves('INVOICE_READY', true)).toEqual(['DISPUTED']);
    expect([...STATUSES_SET_ELSEWHERE].sort()).toEqual(['ASSIGNED', 'INVOICE_SENT', 'PAID', 'PAYMENT_PENDING', 'QUOTE_ACCEPTED', 'QUOTE_SENT']);

    for (const status of CANONICAL_STATUSES) {
      for (const hasArtisan of [true, false]) {
        for (const elsewhere of STATUSES_SET_ELSEWHERE) {
          expect(moves(status, hasArtisan)).not.toContain(elsewhere);
        }
      }
    }
  });

  it('nothing leaves a cancelled job, and nothing is offered for a status nobody knows', () => {
    expect(moves('CANCELLED', true)).toEqual([]);
    expect(moves('CANCELLED', false)).toEqual([]);
    expect(moves('NOPE', true)).toEqual([]);
    expect(moves('', false)).toEqual([]);
  });

  it('every move offered is a move the table lets staff make, and one the server will not refuse for a missing artisan', () => {
    for (const status of CANONICAL_STATUSES) {
      for (const hasArtisan of [true, false]) {
        for (const to of moves(status, hasArtisan)) {
          expect(`${status} -> ${to}: ${checkTransition(status, to, 'staff').ok}`).toBe(`${status} -> ${to}: true`);

          if (!hasArtisan) expect(STATUSES_NEEDING_ARTISAN).not.toContain(to);
        }
      }
    }
  });

  it('the status itself is never offered as a move', () => {
    for (const status of CANONICAL_STATUSES) {
      expect(moves(status, true)).not.toContain(status);
    }
  });
});

describe('appFacingStatus: the spelling a staff member\'s change is stored in (P1-13)', () => {
  it('is the old name the apps read, until STATUS_STORAGE=canonical', () => {
    expect(appFacingStatus('ARTISAN_ACCEPTED', undefined)).toBe('ACCEPTED');
    expect(appFacingStatus('ARTISAN_ON_THE_WAY', undefined)).toBe('ON_THE_WAY');
    expect(appFacingStatus('ARTISAN_ARRIVED', undefined)).toBe('ARRIVED');
    expect(appFacingStatus('WAITING_ADMIN_REVIEW', undefined)).toBe('ADMIN_REVIEW');
    expect(appFacingStatus('CREATED', 'legacy')).toBe('PENDING');
  });

  it('is the canonical name once the storage is canonical', () => {
    expect(appFacingStatus('ACCEPTED', 'canonical')).toBe('ARTISAN_ACCEPTED');
    expect(appFacingStatus('ARTISAN_ON_THE_WAY', 'CANONICAL')).toBe('ARTISAN_ON_THE_WAY');
    expect(appFacingStatus('PENDING', 'canonical')).toBe('CREATED');
  });

  it('a status with no old name keeps its name, and a spelling nobody knows is left as it is', () => {
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'WAITING_CLIENT_VALIDATION']) {
      expect(appFacingStatus(status, undefined)).toBe(status);
    }

    expect(appFacingStatus('NOPE', undefined)).toBe('NOPE');
  });

  it('the old name still means the same status (the table reads both)', () => {
    for (const status of CANONICAL_STATUSES) {
      expect(canonicalStatus(appFacingStatus(status, undefined))).toBe(status);
      expect(canonicalStatus(appFacingStatus(status, 'canonical'))).toBe(status);
    }
  });
});
