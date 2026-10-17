import {
  assessCapture,
  CaptureFacts,
  DEFAULT_POLICY,
  distanceMeters,
  FLAGS,
  getProofPolicy,
  isNote,
  isRefusal,
  NOTES,
  isUsablePosition,
  REFUSALS,
  refusalMessage,
} from './proof-policy';

// A job in Tunis (Avenue Habib Bourguiba). One degree of latitude is ~111.2 km, so
// 0.001 degree of latitude is ~111 m.
const JOB = { latitude: 36.8008, longitude: 10.1815 };
const NOW = new Date('2026-10-17T10:00:00Z');

const facts = (over: Partial<CaptureFacts> = {}): CaptureFacts => ({
  latitude: JOB.latitude,
  longitude: JOB.longitude,
  accuracyM: 10,
  mocked: false,
  clientCapturedAt: NOW,
  receivedAt: NOW,
  job: { ...JOB },
  picture: { alreadyUsed: false, similarTo: null, blank: false },
  ...over,
});

const north = (meters: number) => JOB.latitude + meters / 111_195;

describe('distanceMeters', () => {
  it('is zero for the same point and symmetric', () => {
    expect(distanceMeters(JOB.latitude, JOB.longitude, JOB.latitude, JOB.longitude)).toBe(0);

    const ab = distanceMeters(36.8, 10.18, 36.9, 10.3);
    const ba = distanceMeters(36.9, 10.3, 36.8, 10.18);

    expect(Math.abs(ab - ba)).toBeLessThan(0.000001);
  });

  it('knows how long a degree is', () => {
    expect(distanceMeters(36, 10, 37, 10)).toBeGreaterThan(111_000);
    expect(distanceMeters(36, 10, 37, 10)).toBeLessThan(111_400);
    // A degree of longitude is shorter at 36 degrees north (cos 36 ~ 0.809).
    const lng = distanceMeters(36, 10, 36, 11);
    expect(lng).toBeGreaterThan(89_000);
    expect(lng).toBeLessThan(91_000);
  });

  it('Tunis to Sfax is about 230 km', () => {
    const d = distanceMeters(36.8065, 10.1815, 34.7406, 10.7603);
    expect(d).toBeGreaterThan(225_000);
    expect(d).toBeLessThan(240_000);
  });
});

describe('isUsablePosition', () => {
  it('takes real positions', () => {
    expect(isUsablePosition(36.8, 10.18)).toBe(true);
    expect(isUsablePosition(-33.9, -70.6)).toBe(true);
    expect(isUsablePosition(90, 180)).toBe(true);
  });

  it('refuses what the earth does not have, and the (0, 0) of a phone without a fix', () => {
    expect(isUsablePosition(0, 0)).toBe(false);
    expect(isUsablePosition(91, 10)).toBe(false);
    expect(isUsablePosition(36, 181)).toBe(false);
    expect(isUsablePosition(NaN, 10)).toBe(false);
    expect(isUsablePosition(36, Infinity)).toBe(false);
    expect(isUsablePosition('36' as any, 10)).toBe(false);
    expect(isUsablePosition(null, null)).toBe(false);
    expect(isUsablePosition(undefined, 10)).toBe(false);
  });

  it('(0, 10) and (36, 0) are real places', () => {
    expect(isUsablePosition(0, 10)).toBe(true);
    expect(isUsablePosition(36, 0)).toBe(true);
  });
});

describe('getProofPolicy', () => {
  it('has the defaults when nothing is set', () => {
    expect(getProofPolicy({})).toEqual(DEFAULT_POLICY);
  });

  it('reads the environment', () => {
    const policy = getProofPolicy({
      PROOF_REVIEW_DISTANCE_M: '150',
      PROOF_REJECT_DISTANCE_M: '900',
      PROOF_POOR_ACCURACY_M: '50',
      PROOF_REJECT_ACCURACY_M: '400',
      PROOF_CLOCK_TOLERANCE_MINUTES: '5',
      PROOF_SIMILARITY_BITS: '2',
      PROOF_REQUIRE_GPS_QUALITY: 'true',
      PROOF_REVIEW_UNLOCATED: '1',
    } as any);

    expect(policy.reviewDistanceM).toBe(150);
    expect(policy.rejectDistanceM).toBe(900);
    expect(policy.poorAccuracyM).toBe(50);
    expect(policy.rejectAccuracyM).toBe(400);
    expect(policy.clockToleranceMinutes).toBe(5);
    expect(policy.similarityBits).toBe(2);
    expect(policy.requireGpsQuality).toBe(true);
    expect(policy.reviewUnlocated).toBe(true);
  });

  it('ignores values that make no sense', () => {
    const policy = getProofPolicy({
      PROOF_REVIEW_DISTANCE_M: 'abc',
      PROOF_REJECT_DISTANCE_M: '-5',
      PROOF_POOR_ACCURACY_M: '0',
      PROOF_CLOCK_TOLERANCE_MINUTES: '999999',
      PROOF_SIMILARITY_BITS: '40',
      PROOF_REQUIRE_GPS_QUALITY: 'maybe',
    } as any);

    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it('keeps "look at it" before "refuse it": thresholds in the wrong order fall back to the defaults', () => {
    const distances = getProofPolicy({ PROOF_REVIEW_DISTANCE_M: '5000', PROOF_REJECT_DISTANCE_M: '1000' } as any);

    expect(distances.reviewDistanceM).toBe(DEFAULT_POLICY.reviewDistanceM);
    expect(distances.rejectDistanceM).toBe(DEFAULT_POLICY.rejectDistanceM);

    const accuracies = getProofPolicy({ PROOF_POOR_ACCURACY_M: '800', PROOF_REJECT_ACCURACY_M: '200' } as any);

    expect(accuracies.poorAccuracyM).toBe(DEFAULT_POLICY.poorAccuracyM);
    expect(accuracies.rejectAccuracyM).toBe(DEFAULT_POLICY.rejectAccuracyM);
  });
});

describe('assessCapture: a good capture', () => {
  it('on the spot, sure of its position, not simulated, a fresh photo: accepted without a word', () => {
    const result = assessCapture(facts());

    expect(result.verdict).toBe('ACCEPTED');
    expect(result.reasons).toEqual([]);
    expect(result.distanceM).toBe(0);
    expect(result.clockOffsetSeconds).toBe(0);
  });

  it('a few dozen metres away is still the same door', () => {
    const result = assessCapture(facts({ latitude: north(60) }));

    expect(result.verdict).toBe('ACCEPTED');
    expect(result.distanceM).toBeGreaterThan(55);
    expect(result.distanceM).toBeLessThan(65);
  });
});

describe('assessCapture: the mocked-location flag', () => {
  it('a position the phone says is simulated is refused, even when it is exactly at the job', () => {
    const result = assessCapture(facts({ mocked: true }));

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toEqual(['MOCKED_LOCATION']);
  });

  it('a phone that does not say is not accused', () => {
    expect(assessCapture(facts({ mocked: null })).verdict).toBe('ACCEPTED');
  });

  it('unless the policy asks to know: then it is looked at', () => {
    const result = assessCapture(facts({ mocked: null }), { ...DEFAULT_POLICY, requireGpsQuality: true });

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['GPS_QUALITY_UNKNOWN']);
  });

  it('and the same when it does not say how sure it is', () => {
    const result = assessCapture(facts({ accuracyM: null }), { ...DEFAULT_POLICY, requireGpsQuality: true });

    expect(result.reasons).toEqual(['GPS_QUALITY_UNKNOWN']);
  });
});

describe('assessCapture: far from the job', () => {
  it('between the two limits: kept, but looked at', () => {
    const result = assessCapture(facts({ latitude: north(800) }));

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['FAR_FROM_JOB']);
    expect(result.distanceM).toBeGreaterThan(790);
  });

  it('past the far limit: refused, and the message says how far', () => {
    const result = assessCapture(facts({ latitude: north(5000) }));

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toEqual(['TOO_FAR_FROM_JOB']);
    expect(refusalMessage(result)).toContain('5,0 km');
  });

  it('another town altogether is refused', () => {
    const result = assessCapture(facts({ latitude: 34.7406, longitude: 10.7603 }));

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toContain('TOO_FAR_FROM_JOB');
  });

  it('the review limit is the limit: just inside is accepted, just outside is looked at', () => {
    expect(assessCapture(facts({ latitude: north(290), accuracyM: 5 })).verdict).toBe('ACCEPTED');
    expect(assessCapture(facts({ latitude: north(320), accuracyM: 5 })).verdict).toBe('NEEDS_REVIEW');
  });

  it('the refusal limit is the limit: just inside is looked at, just outside is refused', () => {
    expect(assessCapture(facts({ latitude: north(1980), accuracyM: 5 })).verdict).toBe('NEEDS_REVIEW');
    expect(assessCapture(facts({ latitude: north(2100), accuracyM: 5 })).verdict).toBe('REJECTED');
  });

  it('a fix that is not sure of itself gets the benefit of its radius, up to 100 m', () => {
    // 380 m away with a 90 m radius: 290 m effective, inside the review limit.
    const inside = assessCapture(facts({ latitude: north(380), accuracyM: 90 }));

    expect(inside.verdict).toBe('ACCEPTED');
    expect(inside.distanceM).toBeGreaterThan(375);
    expect(inside.effectiveDistanceM).toBeLessThan(300);

    // The same distance with a perfect fix is looked at.
    expect(assessCapture(facts({ latitude: north(380), accuracyM: 5 })).verdict).toBe('NEEDS_REVIEW');
  });

  it('the benefit stops at 100 m: a radius of 900 m does not make 1 400 m "on the spot"', () => {
    const result = assessCapture(facts({ latitude: north(1400), accuracyM: 900 }));

    expect(result.effectiveDistanceM).toBeGreaterThan(1290);
    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toContain('FAR_FROM_JOB');
    expect(result.reasons).toContain('POOR_ACCURACY');
  });

  it('a job that was never put on the map: nothing to compare with, so it is noted and nobody is asked to look', () => {
    const result = assessCapture(facts({ job: { latitude: null, longitude: null } }));

    expect(result.verdict).toBe('ACCEPTED');
    expect(result.reasons).toEqual(['JOB_NOT_LOCATED']);
    expect(result.distanceM).toBeNull();
  });

  it('unless the policy asks for a look at every photo of such a job', () => {
    const result = assessCapture(facts({ job: { latitude: null, longitude: null } }), {
      ...DEFAULT_POLICY,
      reviewUnlocated: true,
    });

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['JOB_NOT_LOCATED']);
  });

  it('the other checks still apply to a job that is not on the map', () => {
    expect(assessCapture(facts({ job: { latitude: null, longitude: null }, mocked: true })).verdict).toBe('REJECTED');
    expect(assessCapture(facts({ job: { latitude: null, longitude: null }, accuracyM: 300 })).verdict).toBe('NEEDS_REVIEW');
    expect(
      assessCapture(facts({ job: { latitude: null, longitude: null }, picture: { alreadyUsed: true, similarTo: null, blank: false } })).verdict,
    ).toBe('REJECTED');
  });

  it('a job with half an address on the map is not located either', () => {
    const result = assessCapture(facts({ job: { latitude: 36.8, longitude: null } }));

    expect(result.reasons).toEqual(['JOB_NOT_LOCATED']);
    expect(result.verdict).toBe('ACCEPTED');
  });

  it('a job sitting at (0, 0) is not located either', () => {
    expect(assessCapture(facts({ job: { latitude: 0, longitude: 0 } })).reasons).toEqual(['JOB_NOT_LOCATED']);
  });
});

describe('assessCapture: the position itself', () => {
  it('(0, 0) is no position: refused, and nothing is measured', () => {
    const result = assessCapture(facts({ latitude: 0, longitude: 0 }));

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toEqual(['POSITION_INVALID']);
    expect(result.distanceM).toBeNull();
  });

  it('NaN is no position', () => {
    expect(assessCapture(facts({ latitude: NaN })).reasons).toContain('POSITION_INVALID');
  });

  it('an invalid position is not also called "job not located"', () => {
    const result = assessCapture(facts({ latitude: NaN, job: { latitude: null, longitude: null } }));

    expect(result.reasons).toEqual(['POSITION_INVALID']);
  });
});

describe('assessCapture: accuracy', () => {
  it('a little unsure: looked at', () => {
    const result = assessCapture(facts({ accuracyM: 250 }));

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['POOR_ACCURACY']);
  });

  it('exactly at the limit is fine', () => {
    expect(assessCapture(facts({ accuracyM: 100 })).verdict).toBe('ACCEPTED');
  });

  it('exactly at the refusal limit is still only looked at; a metre more is refused', () => {
    const atLimit = assessCapture(facts({ accuracyM: DEFAULT_POLICY.rejectAccuracyM }));
    const over = assessCapture(facts({ accuracyM: DEFAULT_POLICY.rejectAccuracyM + 1 }));

    expect(atLimit.verdict).toBe('NEEDS_REVIEW');
    expect(atLimit.reasons).toEqual(['POOR_ACCURACY']);
    expect(over.verdict).toBe('REJECTED');
    expect(over.reasons).toContain('ACCURACY_TOO_LOW');
  });

  it('hopelessly unsure: refused', () => {
    const result = assessCapture(facts({ accuracyM: 5000 }));

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toContain('ACCURACY_TOO_LOW');
    expect(refusalMessage(result)).toContain('GPS');
  });

  it('a negative or non-numeric radius is the same as not saying', () => {
    expect(assessCapture(facts({ accuracyM: -5 })).verdict).toBe('ACCEPTED');
    expect(assessCapture(facts({ accuracyM: NaN })).verdict).toBe('ACCEPTED');
  });
});

describe('assessCapture: a clock that is absurd', () => {
  it('the offset always fits the 32-bit column, whatever the phone says', () => {
    for (const year of [2095, 2100, 2199]) {
      const result = assessCapture(facts({ clientCapturedAt: new Date(Date.UTC(year, 0, 1)) }));

      expect(Math.abs(result.clockOffsetSeconds!)).toBeLessThanOrEqual(2_147_483_647);
      expect(result.reasons).toContain('CLOCK_DIFFERENCE');
      expect(result.verdict).toBe('NEEDS_REVIEW');
    }

    const old = assessCapture(facts({ clientCapturedAt: new Date(0) }));

    expect(Math.abs(old.clockOffsetSeconds!)).toBeLessThanOrEqual(2_147_483_647);
    expect(old.clockOffsetSeconds!).toBeLessThan(0);
  });

  it('a real offset is not touched', () => {
    expect(assessCapture(facts({ clientCapturedAt: new Date(NOW.getTime() + 90_000) })).clockOffsetSeconds).toBe(90);
  });
});

describe('assessCapture: the clock', () => {
  it('the server decides the time, the phone only gets compared', () => {
    const result = assessCapture(facts({ clientCapturedAt: new Date(NOW.getTime() + 5 * 60_000) }));

    expect(result.verdict).toBe('ACCEPTED');
    expect(result.clockOffsetSeconds).toBe(300);
  });

  it('a phone two hours off is looked at', () => {
    const result = assessCapture(facts({ clientCapturedAt: new Date(NOW.getTime() - 2 * 3600_000) }));

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['CLOCK_DIFFERENCE']);
    expect(result.clockOffsetSeconds).toBe(-7200);
  });

  it('a photo "from the future" is looked at too', () => {
    const result = assessCapture(facts({ clientCapturedAt: new Date(NOW.getTime() + 3 * 24 * 3600_000) }));

    expect(result.reasons).toEqual(['CLOCK_DIFFERENCE']);
  });

  it('no time from the phone: nothing to say about it', () => {
    const result = assessCapture(facts({ clientCapturedAt: null }));

    expect(result.verdict).toBe('ACCEPTED');
    expect(result.clockOffsetSeconds).toBeNull();
  });

  it('an invalid date from the phone is the same as none', () => {
    const result = assessCapture(facts({ clientCapturedAt: new Date('nonsense') }));

    expect(result.verdict).toBe('ACCEPTED');
    expect(result.clockOffsetSeconds).toBeNull();
  });
});

describe('assessCapture: the picture', () => {
  it('the same photo twice is refused', () => {
    const result = assessCapture(facts({ picture: { alreadyUsed: true, similarTo: null, blank: false } }));

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toEqual(['PHOTO_ALREADY_USED']);
    expect(refusalMessage(result)).toContain('nouvelle photo');
  });

  it('a picture that looks like an earlier proof is looked at, not refused', () => {
    const result = assessCapture(facts({ picture: { alreadyUsed: false, similarTo: 41, blank: false } }));

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['SIMILAR_TO_EARLIER_PROOF']);
  });

  it('a black frame is looked at', () => {
    const result = assessCapture(facts({ picture: { alreadyUsed: false, similarTo: null, blank: true } }));

    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.reasons).toEqual(['BLANK_PHOTO']);
  });
});

describe('assessCapture: several things at once', () => {
  it('refusals come first, then flags, and the verdict is the worst', () => {
    const result = assessCapture(
      facts({
        mocked: true,
        accuracyM: 250,
        clientCapturedAt: new Date(NOW.getTime() - 3600_000),
        picture: { alreadyUsed: false, similarTo: 7, blank: false },
      }),
    );

    expect(result.verdict).toBe('REJECTED');
    expect(result.reasons).toEqual(['MOCKED_LOCATION', 'POOR_ACCURACY', 'CLOCK_DIFFERENCE', 'SIMILAR_TO_EARLIER_PROOF']);
    const lastRefusal = Math.max(...result.reasons.map((r, i) => (isRefusal(r) ? i : -1)));
    const firstFlag = result.reasons.findIndex((r) => !isRefusal(r));

    expect(firstFlag).toBeGreaterThan(lastRefusal);
  });

  it('a mocked position far away gives both reasons and a message for each', () => {
    const result = assessCapture(facts({ mocked: true, latitude: north(8000) }));

    expect(result.reasons).toEqual(['MOCKED_LOCATION', 'TOO_FAR_FROM_JOB']);

    const message = refusalMessage(result);

    expect(message).toContain('simulée');
    expect(message).toContain('8,0 km');
  });
});

describe('the reason lists', () => {
  it('refusals and flags do not overlap, and isRefusal tells them apart', () => {
    for (const reason of REFUSALS) expect(isRefusal(reason)).toBe(true);
    for (const reason of FLAGS) expect(isRefusal(reason)).toBe(false);
    for (const reason of NOTES) expect(isNote(reason)).toBe(true);

    expect(REFUSALS.filter((r) => (FLAGS as readonly string[]).includes(r))).toEqual([]);
    expect(NOTES.filter((r) => (FLAGS as readonly string[]).includes(r) || (REFUSALS as readonly string[]).includes(r))).toEqual([]);
  });

  it('the refusal message never explains how the check works', () => {
    for (const reason of REFUSALS) {
      const message = refusalMessage({
        verdict: 'REJECTED',
        reasons: [reason],
        distanceM: 5000,
        effectiveDistanceM: 4900,
        clockOffsetSeconds: null,
      });

      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toMatch(/\d+ ?m\b.*(seuil|limite)/i);
      expect(message).not.toMatch(/sha|hash|empreinte|2000|300/i);
    }
  });

  it('with no reason there is still a message', () => {
    expect(refusalMessage({ verdict: 'REJECTED', reasons: [], distanceM: null, effectiveDistanceM: null, clockOffsetSeconds: null })).toBe(
      'La preuve a été refusée.',
    );
  });
});
