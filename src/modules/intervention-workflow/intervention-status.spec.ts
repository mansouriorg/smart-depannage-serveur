import {
  ActorKind,
  CANONICAL_STATUSES,
  CanonicalStatus,
  LEGACY_STATUS_ALIASES,
  STATUS_GROUPS,
  TRANSITIONS,
  actorKindFor,
  allowedNextStatuses,
  canonicalStatus,
  checkTransition,
  initialStatus,
  statusesInGroup,
  storageStatus,
  withAliases,
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
