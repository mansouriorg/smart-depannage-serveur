import {
  AVERAGE_SPEED_KMH,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_STALE_AFTER_MINUTES,
  ROAD_FACTOR,
  arrivalOf,
  positionAge,
  readLocationConfig,
  travelMinutes,
  validPoint,
} from './location-rules';

const NOW = new Date('2026-11-01T10:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('the settings of the position rules (P3-05)', () => {
  it('have defaults: ten minutes of silence, seven days of history', () => {
    expect(readLocationConfig({})).toEqual({ staleAfterMinutes: 10, historyDays: 7 });
    expect(DEFAULT_STALE_AFTER_MINUTES).toBe(10);
    expect(DEFAULT_HISTORY_DAYS).toBe(7);
  });

  it('read the two settings', () => {
    expect(readLocationConfig({ LOCATION_STALE_MINUTES: '15', LOCATION_HISTORY_DAYS: '14' })).toEqual({ staleAfterMinutes: 15, historyDays: 14 });
    expect(readLocationConfig({ LOCATION_STALE_MINUTES: ' 5 ' }).staleAfterMinutes).toBe(5);
  });

  it('ignore a value that is out of its range, not a whole number or not a text', () => {
    for (const bad of ['1', '121', '0', '-5', '7.5', 'ten', '', '  ']) {
      expect(readLocationConfig({ LOCATION_STALE_MINUTES: bad }).staleAfterMinutes).toBe(10);
    }

    for (const bad of ['0', '91', '3.5', 'week']) {
      expect(readLocationConfig({ LOCATION_HISTORY_DAYS: bad }).historyDays).toBe(7);
    }

    expect(readLocationConfig({ LOCATION_STALE_MINUTES: 20 }).staleAfterMinutes).toBe(10);
  });

  it('accept the ends of the ranges', () => {
    expect(readLocationConfig({ LOCATION_STALE_MINUTES: '2' }).staleAfterMinutes).toBe(2);
    expect(readLocationConfig({ LOCATION_STALE_MINUTES: '120' }).staleAfterMinutes).toBe(120);
    expect(readLocationConfig({ LOCATION_HISTORY_DAYS: '1' }).historyDays).toBe(1);
    expect(readLocationConfig({ LOCATION_HISTORY_DAYS: '90' }).historyDays).toBe(90);
  });

  it('are read from the environment of the process when none is given', () => {
    const before = process.env.LOCATION_STALE_MINUTES;

    process.env.LOCATION_STALE_MINUTES = '25';

    try {
      expect(readLocationConfig().staleAfterMinutes).toBe(25);
      expect(positionAge(minutesAgo(24), NOW).state).toBe('fresh');
      expect(positionAge(minutesAgo(25), NOW).state).toBe('stale');
    } finally {
      if (before === undefined) delete process.env.LOCATION_STALE_MINUTES;
      else process.env.LOCATION_STALE_MINUTES = before;
    }
  });
});

describe('how old a position is (P3-05)', () => {
  it('is fresh before the silence limit and stale from it, the limit itself included', () => {
    expect(positionAge(minutesAgo(0), NOW, 10)).toEqual({ state: 'fresh', ageMinutes: 0 });
    expect(positionAge(new Date(NOW.getTime() - 9 * 60_000 - 59_000), NOW, 10)).toEqual({ state: 'fresh', ageMinutes: 9 });
    expect(positionAge(minutesAgo(10), NOW, 10)).toEqual({ state: 'stale', ageMinutes: 10 });
    expect(positionAge(minutesAgo(95), NOW, 10)).toEqual({ state: 'stale', ageMinutes: 95 });
  });

  it('is unknown when nobody knows when the position was sent', () => {
    expect(positionAge(null, NOW, 10)).toEqual({ state: 'unknown', ageMinutes: null });
    expect(positionAge(undefined, NOW, 10)).toEqual({ state: 'unknown', ageMinutes: null });
    expect(positionAge('not a date', NOW, 10)).toEqual({ state: 'unknown', ageMinutes: null });
  });

  it('reads a text or a number of milliseconds as a time, as a position that came through JSON is', () => {
    expect(positionAge(minutesAgo(3).toISOString(), NOW, 10)).toEqual({ state: 'fresh', ageMinutes: 3 });
    expect(positionAge(minutesAgo(30).getTime(), NOW, 10)).toEqual({ state: 'stale', ageMinutes: 30 });
  });

  it('treats a time in the future (a phone with a wrong clock) as fresh, age zero', () => {
    expect(positionAge(new Date(NOW.getTime() + 5 * 60_000), NOW, 10)).toEqual({ state: 'fresh', ageMinutes: 0 });
  });

  it('uses the limit that was asked for', () => {
    expect(positionAge(minutesAgo(4), NOW, 3).state).toBe('stale');
    expect(positionAge(minutesAgo(4), NOW, 5).state).toBe('fresh');
  });
});

describe('a place on the earth (P3-05)', () => {
  it('is a pair of numbers inside the ranges', () => {
    expect(validPoint(36.8, 10.18)).toEqual({ latitude: 36.8, longitude: 10.18 });
    expect(validPoint(-90, 180)).toEqual({ latitude: -90, longitude: 180 });
    expect(validPoint(90, -180)).toEqual({ latitude: 90, longitude: -180 });
  });

  it('is not a number out of range, not a number, or a text', () => {
    expect(validPoint(90.0001, 10)).toBe(null);
    expect(validPoint(-90.0001, 10)).toBe(null);
    expect(validPoint(36, 180.0001)).toBe(null);
    expect(validPoint(36, -180.0001)).toBe(null);
    expect(validPoint(NaN, 10)).toBe(null);
    expect(validPoint(36, Infinity)).toBe(null);
    expect(validPoint('36.8', '10.1')).toBe(null);
    expect(validPoint(null, undefined)).toBe(null);
  });

  it('is not 0,0, which is what a phone reports when it has no reading, but a zero on one side is a place', () => {
    expect(validPoint(0, 0)).toBe(null);
    expect(validPoint(0, 10)).toEqual({ latitude: 0, longitude: 10 });
    expect(validPoint(36, 0)).toEqual({ latitude: 36, longitude: 0 });
  });
});

describe('the driving time (P3-05)', () => {
  it('is the straight line made longer by the road factor, at the average speed, rounded up', () => {
    expect(AVERAGE_SPEED_KMH).toBe(30);
    expect(ROAD_FACTOR).toBe(1.3);
    // 10 km straight -> 13 km of road -> 26 minutes at 30 km/h
    expect(travelMinutes(10)).toBe(26);
    // 5 km -> 6.5 km -> 13 minutes
    expect(travelMinutes(5)).toBe(13);
    // 1 km -> 1.3 km -> 2.6 minutes -> 3
    expect(travelMinutes(1)).toBe(3);
  });

  it('is at least one minute, also for a technician already at the door', () => {
    expect(travelMinutes(0)).toBe(1);
    expect(travelMinutes(0.01)).toBe(1);
  });

  it('is nothing for a distance that is not a distance', () => {
    expect(travelMinutes(-1)).toBe(null);
    expect(travelMinutes(NaN)).toBe(null);
    expect(travelMinutes(Infinity)).toBe(null);
    expect(travelMinutes('4' as never)).toBe(null);
  });
});

describe('the arrival of a technician who is on the way (P3-05)', () => {
  // Tunis centre and a point about 5.5 km north of it
  const technician = { latitude: 36.8065, longitude: 10.1815, positionAt: minutesAgo(1) };
  const door = { latitude: 36.8565, longitude: 10.1815 };

  it('gives the minutes from a fresh position to the job', () => {
    const arrival = arrivalOf({ artisan: technician, destination: door, now: NOW, staleAfterMinutes: 10 });

    expect(arrival.state).toBe('fresh');
    expect(arrival.ageMinutes).toBe(1);
    // 5.56 km straight -> 7.2 km of road -> 14.5 minutes -> 15
    expect(arrival.minutes).toBe(15);
  });

  it('gives no minutes from a stale position: the state says why', () => {
    const arrival = arrivalOf({ artisan: { ...technician, positionAt: minutesAgo(25) }, destination: door, now: NOW, staleAfterMinutes: 10 });

    expect(arrival).toEqual({ state: 'stale', minutes: null, ageMinutes: 25 });
  });

  it('gives no minutes when nobody knows when the position was sent, or there is no position', () => {
    expect(arrivalOf({ artisan: { ...technician, positionAt: null }, destination: door, now: NOW })).toEqual({ state: 'unknown', minutes: null, ageMinutes: null });
    expect(arrivalOf({ artisan: { latitude: null, longitude: null, positionAt: minutesAgo(1) }, destination: door, now: NOW })).toEqual({
      state: 'unknown',
      minutes: null,
      ageMinutes: null,
    });
    expect(arrivalOf({ artisan: null, destination: door, now: NOW }).state).toBe('unknown');
  });

  it('gives no minutes for a job with no point on the map, whatever the position says', () => {
    expect(arrivalOf({ artisan: technician, destination: { latitude: null, longitude: null }, now: NOW, staleAfterMinutes: 10 })).toEqual({
      state: 'no-destination',
      minutes: null,
      ageMinutes: 1,
    });
    expect(arrivalOf({ artisan: technician, destination: null, now: NOW }).state).toBe('no-destination');
    expect(arrivalOf({ artisan: technician, destination: { latitude: 0, longitude: 0 }, now: NOW }).state).toBe('no-destination');
  });

  it('is one minute at the door and uses the settings of the process when no limit is given', () => {
    expect(arrivalOf({ artisan: technician, destination: technician, now: NOW }).minutes).toBe(1);
    expect(arrivalOf({ artisan: { ...technician, positionAt: minutesAgo(9) }, destination: door, now: NOW }).state).toBe('fresh');
    expect(arrivalOf({ artisan: { ...technician, positionAt: minutesAgo(10) }, destination: door, now: NOW }).state).toBe('stale');
  });
});
