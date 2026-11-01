import {
  DEFAULT_OFFER_COUNT,
  DEFAULT_OFFER_MINUTES,
  MAX_OFFER_COUNT,
  MAX_OFFER_MINUTES,
  MIN_OFFER_COUNT,
  MIN_OFFER_MINUTES,
  OfferConfig,
  RECENT_OFFER_HOURS,
  becauseOf,
  closureReason,
  isLiveOffer,
  isOfferable,
  offerExpiry,
  offerRequest,
  offerView,
  readOfferConfig,
  readOffer,
  recentSince,
  reservedAgainst,
} from './offer-rules';

const NOW = new Date('2026-11-02T10:00:00Z');
const MINUTE = 60_000;
const ahead = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

describe('the settings of the offers (P3-07)', () => {
  it('are five technicians for ten minutes when nothing is set', () => {
    expect(readOfferConfig({})).toEqual({ minutes: 10, count: 5 });
    expect([DEFAULT_OFFER_MINUTES, DEFAULT_OFFER_COUNT]).toEqual([10, 5]);
  });

  it('read OFFER_MINUTES and OFFER_COUNT as whole numbers in their range, digits with spaces included', () => {
    expect(readOfferConfig({ OFFER_MINUTES: '30', OFFER_COUNT: ' 3 ' })).toEqual({ minutes: 30, count: 3 });
    expect(readOfferConfig({ OFFER_MINUTES: 45, OFFER_COUNT: 2 })).toEqual({ minutes: 45, count: 2 });
    expect(readOfferConfig({ OFFER_MINUTES: String(MIN_OFFER_MINUTES), OFFER_COUNT: String(MIN_OFFER_COUNT) })).toEqual({ minutes: 1, count: 1 });
    expect(readOfferConfig({ OFFER_MINUTES: String(MAX_OFFER_MINUTES), OFFER_COUNT: String(MAX_OFFER_COUNT) })).toEqual({ minutes: 120, count: 10 });
  });

  it('ignore a value that is out of its range or not a whole number, and use the default', () => {
    for (const bad of ['0', '121', '-5', '1.5', 'ten', '', '5 minutes', null, undefined, Number.NaN, 2.5, {}, true]) {
      expect([bad, readOfferConfig({ OFFER_MINUTES: bad }).minutes]).toEqual([bad, 10]);
    }

    for (const bad of ['0', '11', '-1', '2.5', 'five', '', null, undefined, Number.NaN, 4.2, [], false]) {
      expect([bad, readOfferConfig({ OFFER_COUNT: bad }).count]).toEqual([bad, 5]);
    }
  });
});

describe('what the back office asks for (P3-07)', () => {
  const config: OfferConfig = { minutes: 10, count: 5 };

  it('nothing sent means the settings', () => {
    expect(offerRequest({}, config)).toEqual({ ok: true, count: 5, minutes: 10 });
    expect(offerRequest(undefined, config)).toEqual({ ok: true, count: 5, minutes: 10 });
    expect(offerRequest(null, config)).toEqual({ ok: true, count: 5, minutes: 10 });
    expect(offerRequest({ count: null, minutes: null }, config)).toEqual({ ok: true, count: 5, minutes: 10 });
    expect(offerRequest({}, { minutes: 20, count: 2 })).toEqual({ ok: true, count: 2, minutes: 20 });
  });

  it('what is sent wins over the settings, as numbers or digits', () => {
    expect(offerRequest({ count: 3, minutes: 15 }, config)).toEqual({ ok: true, count: 3, minutes: 15 });
    expect(offerRequest({ count: '4', minutes: ' 7 ' }, config)).toEqual({ ok: true, count: 4, minutes: 7 });
    expect(offerRequest({ count: 1 }, config)).toEqual({ ok: true, count: 1, minutes: 10 });
    expect(offerRequest({ minutes: 120 }, config)).toEqual({ ok: true, count: 5, minutes: 120 });
  });

  it('a number outside its range is refused, not corrected, and says which one', () => {
    expect(offerRequest({ count: 0 }, config)).toEqual({ ok: false, field: 'count' });
    expect(offerRequest({ count: 11 }, config)).toEqual({ ok: false, field: 'count' });
    expect(offerRequest({ count: 10 }, config)).toEqual({ ok: true, count: 10, minutes: 10 });
    expect(offerRequest({ minutes: 0 }, config)).toEqual({ ok: false, field: 'minutes' });
    expect(offerRequest({ minutes: 121 }, config)).toEqual({ ok: false, field: 'minutes' });
    expect(offerRequest({ count: 50, minutes: 50 }, config)).toEqual({ ok: false, field: 'count' });
  });

  it('what is not a whole number is refused: a fraction, a word, a flag, a list', () => {
    for (const count of [1.5, 'many', true, [3], {}, '3.5', '', '-2']) {
      expect([count, offerRequest({ count }, config)]).toEqual([count, { ok: false, field: 'count' }]);
    }

    for (const minutes of [2.5, 'soon', false, [10], {}, '1e1', '']) {
      expect([minutes, offerRequest({ minutes }, config)]).toEqual([minutes, { ok: false, field: 'minutes' }]);
    }
  });
});

describe('live offers (P3-07)', () => {
  it('an offer is live while it waits and its time has not run out', () => {
    expect(isLiveOffer({ status: 'PENDING', expiresAt: ahead(1) }, NOW)).toBe(true);
    expect(isLiveOffer({ status: 'PENDING', expiresAt: ahead(0.001) }, NOW)).toBe(true);
  });

  it('the instant it runs out it is gone, and so is anything after', () => {
    expect(isLiveOffer({ status: 'PENDING', expiresAt: NOW }, NOW)).toBe(false);
    expect(isLiveOffer({ status: 'PENDING', expiresAt: ahead(-1) }, NOW)).toBe(false);
  });

  it('an offer that was answered or ended is never live, whatever its time', () => {
    for (const status of ['ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'whatever', null, undefined]) {
      expect([status, isLiveOffer({ status, expiresAt: ahead(60) }, NOW)]).toEqual([status, false]);
    }
  });

  it('an offer with no readable time never reserves a job: it is not live', () => {
    for (const expiresAt of [null, undefined, 'not a date', Number.NaN, new Date('nope')]) {
      expect([String(expiresAt), isLiveOffer({ status: 'PENDING', expiresAt: expiresAt as any }, NOW)]).toEqual([String(expiresAt), false]);
    }
  });

  it('reads the time as a date, a string or a number', () => {
    expect(isLiveOffer({ status: 'PENDING', expiresAt: ahead(5).toISOString() }, NOW)).toBe(true);
    expect(isLiveOffer({ status: 'PENDING', expiresAt: ahead(5).getTime() }, NOW)).toBe(true);
  });
});

describe('which jobs can be offered (P3-07)', () => {
  it('the jobs that wait for a technician, in either spelling of the status', () => {
    for (const status of ['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_ACCEPTED']) expect([status, isOfferable({ status })]).toEqual([status, true]);
  });

  it('a job in the hands of a technician, finished or cancelled is not, nor is a job that is not there or a status nobody knows', () => {
    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SUCH_STATUS', '']) {
      expect([status, isOfferable({ status })]).toEqual([status, false]);
    }

    expect(isOfferable(null)).toBe(false);
    expect(isOfferable(undefined)).toBe(false);
    expect(isOfferable({})).toBe(false);
  });
});

describe('why the offers of a job that is no longer open end (P3-07)', () => {
  it('a cancelled job is cancelled, whatever artisan id it still carries', () => {
    expect(closureReason({ status: 'CANCELLED', artisanId: null })).toBe('CANCELLED');
    expect(closureReason({ status: 'CANCELLED', artisanId: 7 })).toBe('CANCELLED');
  });

  it('a job in the hands of a technician was taken, from assignment to payment', () => {
    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'PAYMENT_PENDING']) {
      expect(closureReason({ status, artisanId: 7 })).toBe('TAKEN');
    }
  });

  it('any other job that left the queue (a quote sent, a dispute, a leftover artisan id, a finished job) has no reason to give', () => {
    expect(closureReason({ status: 'QUOTE_SENT', artisanId: null })).toBeNull();
    expect(closureReason({ status: 'QUOTE_SENT', artisanId: 7 })).toBeNull();
    expect(closureReason({ status: 'DISPUTED', artisanId: null })).toBeNull();
    expect(closureReason({ status: 'COMPLETED', artisanId: 7 })).toBeNull();
    expect(closureReason(null)).toBeNull();
    expect(closureReason({ status: 'ASSIGNED', artisanId: null })).toBeNull();
  });

  it('is told to the app by the word it picks a sentence by, "closed" when there is no reason', () => {
    expect([becauseOf('TAKEN'), becauseOf('ASSIGNED'), becauseOf('CANCELLED'), becauseOf('STAFF'), becauseOf(null)]).toEqual(['taken', 'assigned', 'cancelled', 'staff', 'closed']);
  });
});

describe('what an offer is called when it is read (P3-07)', () => {
  const open = { status: 'CREATED' };
  const taken = { status: 'ASSIGNED' };

  it('an offer that ended says so, whatever the job and the clock are', () => {
    expect(readOffer({ status: 'ACCEPTED', expiresAt: ahead(5) }, taken, NOW)).toEqual({ state: 'accepted', because: null });
    expect(readOffer({ status: 'DECLINED', expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'declined', because: null });
    expect(readOffer({ status: 'EXPIRED', expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'expired', because: null });
  });

  it('a withdrawn offer says why', () => {
    for (const [reason, because] of [['TAKEN', 'taken'], ['ASSIGNED', 'assigned'], ['CANCELLED', 'cancelled'], ['STAFF', 'staff']]) {
      expect(readOffer({ status: 'WITHDRAWN', withdrawnReason: reason, expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'withdrawn', because });
    }

    expect(readOffer({ status: 'WITHDRAWN', withdrawnReason: null, expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'withdrawn', because: 'closed' });
    expect(readOffer({ status: 'WITHDRAWN', withdrawnReason: 'SOMETHING_NEW', expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'withdrawn', because: 'closed' });
  });

  it('a waiting offer is open while the job is open and the time has not run out', () => {
    expect(readOffer({ status: 'PENDING', expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'open', because: null });
  });

  it('a waiting offer is withdrawn once the job is not open any more (the sweep has not written it yet), and that wins over the clock', () => {
    expect(readOffer({ status: 'PENDING', expiresAt: ahead(5) }, taken, NOW)).toEqual({ state: 'withdrawn', because: 'closed' });
    expect(readOffer({ status: 'PENDING', expiresAt: ahead(-5) }, taken, NOW)).toEqual({ state: 'withdrawn', because: 'closed' });
    expect(readOffer({ status: 'PENDING', expiresAt: ahead(5) }, null, NOW)).toEqual({ state: 'withdrawn', because: 'closed' });
  });

  it('a waiting offer whose time ran out is expired', () => {
    expect(readOffer({ status: 'PENDING', expiresAt: ahead(-1) }, open, NOW)).toEqual({ state: 'expired', because: null });
    expect(readOffer({ status: 'PENDING', expiresAt: NOW }, open, NOW)).toEqual({ state: 'expired', because: null });
  });

  it('a status nobody knows is not open', () => {
    expect(readOffer({ status: 'SOMETHING', expiresAt: ahead(5) }, open, NOW)).toEqual({ state: 'withdrawn', because: 'closed' });
  });
});

describe('a job reserved against a technician (P3-07)', () => {
  it('is reserved when some offer is live and none is theirs', () => {
    expect(reservedAgainst([{ artisanId: 2 }, { artisanId: 3 }], 1)).toBe(true);
  });

  it('is not reserved against the technicians it was offered to', () => {
    expect(reservedAgainst([{ artisanId: 2 }, { artisanId: 3 }], 3)).toBe(false);
    expect(reservedAgainst([{ artisanId: 2 }], 2)).toBe(false);
  });

  it('is not reserved at all when no offer is live', () => {
    expect(reservedAgainst([], 1)).toBe(false);
  });
});

describe('the clock of the offers (P3-07)', () => {
  it('an offer made now lasts that many minutes', () => {
    expect(offerExpiry(NOW, 10).toISOString()).toBe('2026-11-02T10:10:00.000Z');
    expect(offerExpiry(NOW, 120).toISOString()).toBe('2026-11-02T12:00:00.000Z');
  });

  it('an ended offer is listed for a day', () => {
    expect(RECENT_OFFER_HOURS).toBe(24);
    expect(recentSince(NOW).toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });
});

describe('an offer as the technician reads it (P3-07)', () => {
  it('carries its state and its dates, and nothing about the round', () => {
    const row = { id: 5, interventionId: 9, status: 'PENDING', expiresAt: ahead(5), offeredAt: ahead(-5), respondedAt: null, rank: 2, score: 88, round: 3, artisanId: 12, offeredById: 7 };
    const view = offerView(row, { status: 'CREATED' }, NOW);

    expect(view).toEqual({ id: 5, interventionId: 9, state: 'open', because: null, offeredAt: row.offeredAt, expiresAt: row.expiresAt, respondedAt: null });
    expect(Object.keys(view).sort()).toEqual(['because', 'expiresAt', 'id', 'interventionId', 'offeredAt', 'respondedAt', 'state']);
  });

  it('missing dates are null, not undefined', () => {
    const view = offerView({ id: 1, interventionId: 2, status: 'DECLINED', expiresAt: undefined }, { status: 'CREATED' }, NOW);

    expect([view.offeredAt, view.expiresAt, view.respondedAt]).toEqual([null, null, null]);
  });
});
