import {
  ACTIVE_APPOINTMENT_STATUSES,
  ACTIVE_JOB_STATUSES,
  ISSUE_AT_MAXIMUM,
  ISSUE_NOT_ACCEPTING,
  ISSUE_NO_EMERGENCY,
  artisanAvailabilityIssues,
  isCurrentVisit,
} from './artisan-availability';

const free = {
  profile: { isAcceptingJobs: true, emergencyAvailable: true, maxActiveJobs: 3, availability: [] as any[] },
  activeJobsCount: 0,
  overlappingAppointments: 0,
  overlappingTimeBlocks: 0,
  timeZone: 'Africa/Tunis',
};

const monday = { startsAt: new Date('2026-10-19T09:00:00Z'), endsAt: new Date('2026-10-19T10:00:00Z') };

describe('artisanAvailabilityIssues', () => {
  it('an artisan with nothing in the way is free, with or without a time', () => {
    expect(artisanAvailabilityIssues(free)).toEqual([]);
    expect(artisanAvailabilityIssues({ ...free, range: monday })).toEqual([]);
  });

  it('without a time only the profile counts: not taking missions, at the maximum, no emergencies', () => {
    expect(artisanAvailabilityIssues({ ...free, profile: { ...free.profile, isAcceptingJobs: false } })).toEqual(['Artisan ne prend pas de missions.']);
    expect(artisanAvailabilityIssues({ ...free, activeJobsCount: 3 })).toEqual(['Artisan au maximum de missions actives.']);
    expect(artisanAvailabilityIssues({ ...free, emergency: true, profile: { ...free.profile, emergencyAvailable: false } })).toEqual(['Artisan non disponible pour urgence.']);
    expect(artisanAvailabilityIssues({ ...free, emergency: false, profile: { ...free.profile, emergencyAvailable: false } })).toEqual([]);
  });

  it('an artisan who already holds the job is only judged on the time: missions to come are not this one', () => {
    const profile = { ...free.profile, isAcceptingJobs: false, emergencyAvailable: false, maxActiveJobs: 1 };
    const holding = { ...free, profile, activeJobsCount: 5, emergency: true, holdsTheJob: true };

    expect(artisanAvailabilityIssues(holding)).toEqual([]);
    expect(artisanAvailabilityIssues({ ...holding, range: monday })).toEqual([]);
    expect(artisanAvailabilityIssues({ ...holding, range: monday, overlappingAppointments: 1, overlappingTimeBlocks: 1 })).toEqual([
      'Artisan déjà réservé sur ce créneau.',
      'Artisan indisponible sur ce créneau.',
    ]);
    // and the same artisan, not holding it, is refused for all three
    expect(artisanAvailabilityIssues({ ...holding, holdsTheJob: false }).length).toBe(3);
  });

  it('without a time the weekly schedule, the appointments and the blocks are not looked at', () => {
    const busy = { ...free, overlappingAppointments: 2, overlappingTimeBlocks: 1, profile: { ...free.profile, availability: [{ dayOfWeek: 'FRIDAY', startTime: '08:00', endTime: '09:00', isAvailable: true }] } };

    expect(artisanAvailabilityIssues(busy)).toEqual([]);
  });

  it('with a time: an appointment, a block and the weekly schedule each stand in the way', () => {
    expect(artisanAvailabilityIssues({ ...free, range: monday, overlappingAppointments: 1 })).toEqual(['Artisan déjà réservé sur ce créneau.']);
    expect(artisanAvailabilityIssues({ ...free, range: monday, overlappingTimeBlocks: 1 })).toEqual(['Artisan indisponible sur ce créneau.']);

    const fridaysOnly = { ...free.profile, availability: [{ dayOfWeek: 'FRIDAY', startTime: '08:00', endTime: '17:00', isAvailable: true }] };

    expect(artisanAvailabilityIssues({ ...free, range: monday, profile: fridaysOnly })).toEqual(['Pas disponible sur ce créneau hebdomadaire.']);
  });

  it('says everything that is wrong at once', () => {
    const issues = artisanAvailabilityIssues({ ...free, range: monday, overlappingAppointments: 1, activeJobsCount: 5, profile: { ...free.profile, isAcceptingJobs: false } });

    expect(issues.length).toBe(3);
  });
});

describe('what counts as busy', () => {
  it('an appointment that is done or cancelled does not hold the artisan', () => {
    expect(ACTIVE_APPOINTMENT_STATUSES.includes('CANCELLED' as any)).toBe(false);
    expect(ACTIVE_APPOINTMENT_STATUSES.includes('COMPLETED' as any)).toBe(false);
    expect(ACTIVE_APPOINTMENT_STATUSES.includes('SCHEDULED' as any)).toBe(true);
  });

  it('a finished or cancelled job is not an active mission, in either spelling', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'DISPUTED']) {
      expect(ACTIVE_JOB_STATUSES.includes(status as any)).toBe(false);
    }

    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ACCEPTED', 'IN_PROGRESS', 'ON_THE_WAY']) {
      expect(ACTIVE_JOB_STATUSES.includes(status as any)).toBe(true);
    }
  });
});

describe('the words of the reasons that come from the profile', () => {
  it('are the ones the matching and the assignment have always used', () => {
    expect(ISSUE_NOT_ACCEPTING).toBe('Artisan ne prend pas de missions.');
    expect(ISSUE_NO_EMERGENCY).toBe('Artisan non disponible pour urgence.');
    expect(ISSUE_AT_MAXIMUM).toBe('Artisan au maximum de missions actives.');
  });
});

describe('isCurrentVisit: a visit that is a time somebody is expected', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const hour = 3600_000;
  const visit = (fields: Record<string, unknown> = {}) => ({
    status: 'SCHEDULED' as any,
    startsAt: new Date(now.getTime() + 24 * hour),
    endsAt: new Date(now.getTime() + 25 * hour),
    ...fields,
  });

  it('a visit still to come, in any status that holds the time', () => {
    for (const status of ACTIVE_APPOINTMENT_STATUSES) {
      expect(isCurrentVisit(visit({ status }), now)).toBe(true);
    }
  });

  it('one that is under way counts until it ends', () => {
    expect(isCurrentVisit(visit({ startsAt: new Date(now.getTime() - hour), endsAt: new Date(now.getTime() + hour) }), now)).toBe(true);
  });

  it('not one that is over (the end is not in the future)', () => {
    expect(isCurrentVisit(visit({ startsAt: new Date(now.getTime() - 2 * hour), endsAt: new Date(now.getTime() - hour) }), now)).toBe(false);
    expect(isCurrentVisit(visit({ endsAt: now }), now)).toBe(false);
  });

  it('not one that is cancelled, done, only asked for, or missing', () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'REQUESTED', 'NO_SHOW']) {
      expect(isCurrentVisit(visit({ status }), now)).toBe(false);
    }

    expect(isCurrentVisit(null, now)).toBe(false);
    expect(isCurrentVisit(undefined, now)).toBe(false);
  });

  it('a time needs both its ends', () => {
    expect(isCurrentVisit(visit({ startsAt: null }), now)).toBe(false);
    expect(isCurrentVisit(visit({ endsAt: null }), now)).toBe(false);
    expect(isCurrentVisit(visit({ startsAt: undefined }), now)).toBe(false);
  });

  it('uses the clock when no moment is given', () => {
    const soon = visit({ startsAt: new Date(Date.now() + hour), endsAt: new Date(Date.now() + 2 * hour) });

    expect(isCurrentVisit(soon)).toBe(true);
    expect(isCurrentVisit(visit({ startsAt: new Date(Date.now() - 3 * hour), endsAt: new Date(Date.now() - 2 * hour) }))).toBe(false);
  });
});
