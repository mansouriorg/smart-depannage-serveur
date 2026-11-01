import { MAX_QUEUED_FOR_SECONDS, QUEUED_FOR_HEADER, ROAD_MOMENTS_SELECT, readQueuedFor, whenDone, whenDoneOnJob } from './queued-for';

const RECEIVED = new Date('2026-11-01T17:40:00.000Z');
const at = (iso: string) => new Date(iso);

describe('reading how long the phone held an action (P3-06)', () => {
  it('is a header called x-queued-for and at most seven days', () => {
    expect(QUEUED_FOR_HEADER).toBe('x-queued-for');
    expect(MAX_QUEUED_FOR_SECONDS).toBe(604_800);
  });

  it('reads whole seconds, from a text or a number', () => {
    expect(readQueuedFor('0')).toBe(0);
    expect(readQueuedFor('95')).toBe(95);
    expect(readQueuedFor(' 12600 ')).toBe(12_600);
    expect(readQueuedFor(3600)).toBe(3600);
  });

  it('says 0 (not held) for a missing, empty or unreadable value', () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '-5', '+5', '1.5', '1e3', '0x10', '5, 7', '5 7', NaN, Infinity, -1, 1.5, {}, [], ['5'], true]) {
      expect(readQueuedFor(bad)).toBe(0);
    }
  });

  it('counts more than seven days as seven days, and keeps the very end of the range', () => {
    expect(readQueuedFor('604800')).toBe(604_800);
    expect(readQueuedFor('604801')).toBe(604_800);
    expect(readQueuedFor('99999999999')).toBe(604_800);
  });

  it('refuses a number written with more than twelve digits rather than reading it', () => {
    expect(readQueuedFor('1000000000000')).toBe(0);
  });
});

describe('when a held action was done (P3-06)', () => {
  it('is the time of arrival when nothing was held', () => {
    expect(whenDone(RECEIVED, 0).toISOString()).toBe('2026-11-01T17:40:00.000Z');
    expect(whenDone(RECEIVED, 0, [at('2026-11-01T17:39:00Z')]).toISOString()).toBe('2026-11-01T17:40:00.000Z');
  });

  it('goes back by the seconds the phone held the action', () => {
    expect(whenDone(RECEIVED, 3_480).toISOString()).toBe('2026-11-01T16:42:00.000Z');
    expect(whenDone(RECEIVED, 1).toISOString()).toBe('2026-11-01T17:39:59.000Z');
  });

  it('never goes before the moment of an earlier step of the same job', () => {
    // arrived 14:00; the phone says "started 5 hours ago": it cannot have started before it arrived
    expect(whenDone(RECEIVED, 5 * 3600, [at('2026-11-01T14:00:00Z')]).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('takes the latest of several earlier moments, and ignores those that are missing or not dates', () => {
    const earlier = [null, undefined, '2026-11-01T13:00:00Z', 'not a date', at('2026-11-01T15:30:00Z'), at('2026-11-01T12:00:00Z')];

    expect(whenDone(RECEIVED, 6 * 3600, earlier).toISOString()).toBe('2026-11-01T15:30:00.000Z');
  });

  it('keeps the held time when it is later than the earlier steps', () => {
    expect(whenDone(RECEIVED, 600, [at('2026-11-01T10:00:00Z')]).toISOString()).toBe('2026-11-01T17:30:00.000Z');
  });

  it('is not held back by an earlier moment that is after the arrival', () => {
    expect(whenDone(RECEIVED, 600, [at('2026-11-02T00:00:00Z')]).toISOString()).toBe('2026-11-01T17:30:00.000Z');
  });

  it('is never after the arrival, whatever it is given', () => {
    expect(whenDone(RECEIVED, -30).toISOString()).toBe('2026-11-01T17:40:00.000Z');
    expect(whenDone(RECEIVED, NaN, [at('2026-11-01T17:00:00Z')]).toISOString()).toBe('2026-11-01T17:40:00.000Z');
    // an age that is not a figure is "not held", not "as long as possible"
    expect(whenDone(RECEIVED, Infinity).toISOString()).toBe('2026-11-01T17:40:00.000Z');
    expect(whenDone(RECEIVED, -Infinity).toISOString()).toBe('2026-11-01T17:40:00.000Z');
  });

  it('counts whole seconds only', () => {
    expect(whenDone(RECEIVED, 1.9).toISOString()).toBe('2026-11-01T17:39:59.000Z');
    expect(whenDone(RECEIVED, 0.9).toISOString()).toBe('2026-11-01T17:40:00.000Z');
  });

  it('counts at most seven days, even when the figure is given as a larger number', () => {
    expect(whenDone(RECEIVED, 10 * 24 * 3600).toISOString()).toBe('2026-10-25T17:40:00.000Z');
  });

  it('does not change the date it was given', () => {
    const received = new Date(RECEIVED);

    whenDone(received, 3600);

    expect(received.getTime()).toBe(RECEIVED.getTime());
  });
});

describe('the dates that hold a held action in place (P3-06)', () => {
  it('are the making and the assignment of the job and the four dates of the road', () => {
    expect(Object.keys(ROAD_MOMENTS_SELECT).sort()).toEqual(['artisanAcceptedAt', 'artisanArrivedAt', 'artisanOnTheWayAt', 'assignedAt', 'createdAt', 'workStartedAt']);
  });

  it('a job with no road date is held at its assignment, then at its making', () => {
    const received = new Date(RECEIVED);
    const week = 7 * 24 * 3600;
    const assigned = new Date(RECEIVED.getTime() - 600_000);
    const made = new Date(RECEIVED.getTime() - 1_200_000);

    expect(whenDoneOnJob(received, week, { createdAt: made, assignedAt: assigned }).getTime()).toBe(assigned.getTime());
    expect(whenDoneOnJob(received, week, { createdAt: made, assignedAt: null }).getTime()).toBe(made.getTime());
    expect(whenDoneOnJob(received, week, {}).getTime()).toBe(RECEIVED.getTime() - week * 1000);
  });
});
