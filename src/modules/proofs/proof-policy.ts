/**
 * What makes a proof photo believable (P1-07). Pure rules, no database and no image decoding:
 * the service gathers the facts (where the job is, what was uploaded before) and asks here.
 *
 * A capture is judged on what the SERVER knows. The phone says where it was, how sure it is
 * about that, whether the position was faked and when the photo was taken; none of it can be
 * checked, so none of it is trusted more than it can be compared with:
 *
 *  - the job has an address with coordinates: a photo taken far from it was not taken there;
 *  - a position the phone itself reports as simulated is not a position;
 *  - the same photo twice is not a second proof;
 *  - the time that counts is the one at which the server received the photo; a photo the phone
 *    held until it had a signal says for how long (P3-06), and its clock is compared with ours at
 *    the time it was taken, not at the time it arrived.
 *
 * Three outcomes. REJECTED: the photo is refused, nothing of it is kept but a line for the
 * audit, and the artisan is told why (they can retake it). NEEDS_REVIEW: the photo is kept and
 * the job goes on, but a person of the back office is told to look at it. ACCEPTED: nothing to
 * say.
 */

import { MAX_QUEUED_FOR_SECONDS } from '../../common/time/queued-for';

export type ProofKind = 'BEFORE' | 'AFTER';
export type ProofVerdict = 'ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED';

/** Why a photo is refused. */
export const REFUSALS = [
  'POSITION_INVALID',
  'MOCKED_LOCATION',
  'TOO_FAR_FROM_JOB',
  'ACCURACY_TOO_LOW',
  'PHOTO_ALREADY_USED',
] as const;

/** Why a photo is kept but looked at. */
export const FLAGS = [
  'FAR_FROM_JOB',
  'POOR_ACCURACY',
  'GPS_QUALITY_UNKNOWN',
  'CLOCK_DIFFERENCE',
  'SIMILAR_TO_EARLIER_PROOF',
  'BLANK_PHOTO',
] as const;

/**
 * What is recorded without asking anybody to look: the photo could not be compared with the job
 * because the job was never put on the map. Most jobs made on the website have no coordinates;
 * if every one of their proofs went to the review queue, the queue would be full of photos nobody
 * can judge and the real ones would be lost in it. (PROOF_REVIEW_UNLOCATED=true sends them anyway.)
 */
export const NOTES = ['JOB_NOT_LOCATED'] as const;

export type ProofRefusal = (typeof REFUSALS)[number];
export type ProofFlag = (typeof FLAGS)[number];
export type ProofNote = (typeof NOTES)[number];
export type ProofReason = ProofRefusal | ProofFlag | ProofNote;

export const isRefusal = (reason: string): reason is ProofRefusal => (REFUSALS as readonly string[]).includes(reason);
export const isNote = (reason: string): reason is ProofNote => (NOTES as readonly string[]).includes(reason);

/** The limits. Environment variables change them; a value that makes no sense is ignored. */
export type ProofPolicy = {
  /** Farther than this from the job (after the accuracy's benefit): kept, but looked at. */
  reviewDistanceM: number;
  /** Farther than this: refused. */
  rejectDistanceM: number;
  /** A fix less sure than this: kept, but looked at. */
  poorAccuracyM: number;
  /** A fix less sure than this: refused. */
  rejectAccuracyM: number;
  /** The most an accuracy radius may excuse of the distance. */
  accuracyAllowanceM: number;
  /** The device clock and the server clock may differ by this much (minutes). */
  clockToleranceMinutes: number;
  /** Two photos whose fingerprints differ by this many bits or fewer are "the same picture". */
  similarityBits: number;
  /** A phone that does not say how sure its position is / whether it is simulated is looked at. */
  requireGpsQuality: boolean;
  /** A photo of a job that is not on the map is looked at (otherwise it is only noted). */
  reviewUnlocated: boolean;
};

/** Ten years: far beyond any clock a person would trust, well inside a 32-bit integer. */
const MAX_CLOCK_OFFSET_SECONDS = 10 * 365 * 24 * 3600;

export const DEFAULT_POLICY: ProofPolicy = {
  reviewDistanceM: 300,
  rejectDistanceM: 2000,
  poorAccuracyM: 100,
  rejectAccuracyM: 1000,
  accuracyAllowanceM: 100,
  clockToleranceMinutes: 15,
  similarityBits: 4,
  requireGpsQuality: false,
  reviewUnlocated: false,
};

function numberFrom(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = (env[name] ?? '').trim();

  if (!raw) return fallback;

  const value = Number(raw);

  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function getProofPolicy(env: NodeJS.ProcessEnv = process.env): ProofPolicy {
  const policy: ProofPolicy = {
    reviewDistanceM: numberFrom('PROOF_REVIEW_DISTANCE_M', DEFAULT_POLICY.reviewDistanceM, 10, 100_000, env),
    rejectDistanceM: numberFrom('PROOF_REJECT_DISTANCE_M', DEFAULT_POLICY.rejectDistanceM, 10, 1_000_000, env),
    poorAccuracyM: numberFrom('PROOF_POOR_ACCURACY_M', DEFAULT_POLICY.poorAccuracyM, 1, 100_000, env),
    rejectAccuracyM: numberFrom('PROOF_REJECT_ACCURACY_M', DEFAULT_POLICY.rejectAccuracyM, 1, 1_000_000, env),
    accuracyAllowanceM: DEFAULT_POLICY.accuracyAllowanceM,
    clockToleranceMinutes: numberFrom('PROOF_CLOCK_TOLERANCE_MINUTES', DEFAULT_POLICY.clockToleranceMinutes, 1, 1_440, env),
    similarityBits: numberFrom('PROOF_SIMILARITY_BITS', DEFAULT_POLICY.similarityBits, 0, 16, env),
    requireGpsQuality: ['1', 'true', 'yes'].includes((env.PROOF_REQUIRE_GPS_QUALITY ?? '').trim().toLowerCase()),
    reviewUnlocated: ['1', 'true', 'yes'].includes((env.PROOF_REVIEW_UNLOCATED ?? '').trim().toLowerCase()),
  };

  // The thresholds must keep their order: "look at it" comes before "refuse it".
  if (policy.rejectDistanceM <= policy.reviewDistanceM) {
    policy.reviewDistanceM = DEFAULT_POLICY.reviewDistanceM;
    policy.rejectDistanceM = DEFAULT_POLICY.rejectDistanceM;
  }

  if (policy.rejectAccuracyM <= policy.poorAccuracyM) {
    policy.poorAccuracyM = DEFAULT_POLICY.poorAccuracyM;
    policy.rejectAccuracyM = DEFAULT_POLICY.rejectAccuracyM;
  }

  return policy;
}

// ----------------------------------------------------------
// Geography
// ----------------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two points given in degrees. */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A position the earth has: finite, in range, and not the (0, 0) a phone reports when it has no fix. */
export function isUsablePosition(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

// ----------------------------------------------------------
// The judgment
// ----------------------------------------------------------

export type CaptureFacts = {
  /** Where the phone says it was. */
  latitude: number;
  longitude: number;
  /** How sure the phone is, in metres; null when it did not say. */
  accuracyM: number | null;
  /** Whether the phone says the position was simulated; null when it did not say. */
  mocked: boolean | null;
  /** The time the phone says the photo was taken at; null when it did not say. */
  clientCapturedAt: Date | null;
  /** When the server received it. */
  receivedAt: Date;
  /**
   * How long the phone held the photo before it could send it, in seconds (P3-06; 0 or missing: it did not). The phone's clock is then compared with
   * the server's at the moment the photo was taken, which is the arrival minus this.
   */
  queuedForSeconds?: number;
  /** Where the job is; null when it was never located. */
  job: { latitude: number | null; longitude: number | null };
  /** What the picture looks like next to the ones that came before. */
  picture: {
    /** The same bytes were already used as a proof. */
    alreadyUsed: boolean;
    /** The id of an earlier proof that looks the same (not the same bytes), if any. */
    similarTo: number | null;
    /** Almost no detail in the picture (a covered lens, a black frame). */
    blank: boolean;
  };
};

export type Assessment = {
  verdict: ProofVerdict;
  /** Refusals first, then flags, then notes. Empty when there is nothing to say. */
  reasons: ProofReason[];
  /** Metres between the photo and the job, null when it cannot be known. */
  distanceM: number | null;
  /** Metres once the accuracy's benefit is taken off, null when it cannot be known. */
  effectiveDistanceM: number | null;
  /** Seconds the phone's clock is ahead of (+) or behind (-) the server's, null when it did not say. */
  clockOffsetSeconds: number | null;
};

export function assessCapture(facts: CaptureFacts, policy: ProofPolicy = getProofPolicy()): Assessment {
  const refusals: ProofRefusal[] = [];
  const flags: ProofFlag[] = [];
  const notes: ProofNote[] = [];

  const positionOk = isUsablePosition(facts.latitude, facts.longitude);
  const accuracy =
    facts.accuracyM !== null && Number.isFinite(facts.accuracyM) && facts.accuracyM >= 0 ? facts.accuracyM : null;

  if (!positionOk) refusals.push('POSITION_INVALID');
  if (facts.mocked === true) refusals.push('MOCKED_LOCATION');
  if (facts.picture.alreadyUsed) refusals.push('PHOTO_ALREADY_USED');

  // Accuracy.
  if (accuracy !== null && accuracy > policy.rejectAccuracyM) refusals.push('ACCURACY_TOO_LOW');
  else if (accuracy !== null && accuracy > policy.poorAccuracyM) flags.push('POOR_ACCURACY');

  if (policy.requireGpsQuality && (accuracy === null || facts.mocked === null)) flags.push('GPS_QUALITY_UNKNOWN');

  // Distance from the job.
  const located =
    facts.job.latitude !== null &&
    facts.job.longitude !== null &&
    isUsablePosition(facts.job.latitude, facts.job.longitude);
  let distanceM: number | null = null;
  let effectiveDistanceM: number | null = null;

  if (positionOk && located) {
    distanceM = distanceMeters(facts.latitude, facts.longitude, facts.job.latitude as number, facts.job.longitude as number);
    effectiveDistanceM = Math.max(0, distanceM - Math.min(accuracy ?? 0, policy.accuracyAllowanceM));

    if (effectiveDistanceM > policy.rejectDistanceM) refusals.push('TOO_FAR_FROM_JOB');
    else if (effectiveDistanceM > policy.reviewDistanceM) flags.push('FAR_FROM_JOB');
  } else if (positionOk && !located) {
    // The address was never put on the map: there is nothing to compare the photo with.
    notes.push('JOB_NOT_LOCATED');
  }

  // The phone's clock against the server's.
  let clockOffsetSeconds: number | null = null;

  if (facts.clientCapturedAt && !Number.isNaN(facts.clientCapturedAt.getTime())) {
    // The column is a 32-bit integer: a clock set to the year 2100 must not make the write fail.
    const heldRaw = Number(facts.queuedForSeconds ?? 0);
    // (An unreadable figure counts as not held, as in `whenDone`.)
    const held = Number.isFinite(heldRaw) ? Math.max(0, Math.min(MAX_QUEUED_FOR_SECONDS, Math.floor(heldRaw))) : 0;
    const takenAt = facts.receivedAt.getTime() - held * 1000;

    clockOffsetSeconds = Math.max(
      -MAX_CLOCK_OFFSET_SECONDS,
      Math.min(MAX_CLOCK_OFFSET_SECONDS, Math.round((facts.clientCapturedAt.getTime() - takenAt) / 1000)),
    );

    if (Math.abs(clockOffsetSeconds) > policy.clockToleranceMinutes * 60) flags.push('CLOCK_DIFFERENCE');
  }

  // The picture.
  if (facts.picture.similarTo !== null) flags.push('SIMILAR_TO_EARLIER_PROOF');
  if (facts.picture.blank) flags.push('BLANK_PHOTO');

  const reviewed = flags.length > 0 || (policy.reviewUnlocated && notes.length > 0);
  const reasons: ProofReason[] = [...refusals, ...flags, ...notes];

  return {
    verdict: refusals.length ? 'REJECTED' : reviewed ? 'NEEDS_REVIEW' : 'ACCEPTED',
    reasons,
    distanceM: distanceM === null ? null : Math.round(distanceM),
    effectiveDistanceM: effectiveDistanceM === null ? null : Math.round(effectiveDistanceM),
    clockOffsetSeconds,
  };
}

// ----------------------------------------------------------
// Words
// ----------------------------------------------------------

const formatDistance = (meters: number) =>
  meters >= 1000 ? `${(meters / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(meters)} m`;

/** What the artisan is told when the photo is refused: what to do, never how the check works. */
export function refusalMessage(assessment: Assessment): string {
  const parts: string[] = [];

  for (const reason of assessment.reasons) {
    if (reason === 'POSITION_INVALID') {
      parts.push('La position GPS de la photo n’est pas valide. Activez le GPS puis reprenez la photo.');
    } else if (reason === 'MOCKED_LOCATION') {
      parts.push('Une position simulée a été détectée. Désactivez les applications de fausse position puis reprenez la photo.');
    } else if (reason === 'TOO_FAR_FROM_JOB') {
      parts.push(
        `Vous semblez être à ${formatDistance(assessment.distanceM ?? 0)} de l’adresse de l’intervention. Rendez-vous sur place puis reprenez la photo.`,
      );
    } else if (reason === 'ACCURACY_TOO_LOW') {
      parts.push('Le signal GPS est trop imprécis. Sortez à l’air libre, attendez quelques secondes puis reprenez la photo.');
    } else if (reason === 'PHOTO_ALREADY_USED') {
      parts.push('Cette photo a déjà été utilisée comme preuve. Prenez une nouvelle photo.');
    }
  }

  return parts.length ? parts.join(' ') : 'La preuve a été refusée.';
}

/** What a person of the back office reads next to a proof: one sentence per reason. */
export function staffReasonText(
  reason: string,
  context: { distanceM?: number | null; accuracyM?: number | null; clockOffsetSeconds?: number | null } = {},
): string {
  switch (reason) {
    case 'POSITION_INVALID':
      return 'Position GPS absente ou invalide.';
    case 'MOCKED_LOCATION':
      return 'Le téléphone signale une position simulée.';
    case 'TOO_FAR_FROM_JOB':
      return `Photo prise à ${formatDistance(context.distanceM ?? 0)} de l’adresse.`;
    case 'ACCURACY_TOO_LOW':
      return `Signal GPS trop imprécis (${Math.round(context.accuracyM ?? 0)} m).`;
    case 'PHOTO_ALREADY_USED':
      return 'Cette photo a déjà servi de preuve.';
    case 'FAR_FROM_JOB':
      return `Photo prise à ${formatDistance(context.distanceM ?? 0)} de l’adresse.`;
    case 'POOR_ACCURACY':
      return `Signal GPS peu précis (${Math.round(context.accuracyM ?? 0)} m).`;
    case 'GPS_QUALITY_UNKNOWN':
      return 'Le téléphone n’a pas indiqué la précision du GPS ni si la position est simulée.';
    case 'CLOCK_DIFFERENCE': {
      const minutes = Math.round(Math.abs(context.clockOffsetSeconds ?? 0) / 60);
      return `L’heure du téléphone diffère de ${minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`} de celle du serveur.`;
    }
    case 'SIMILAR_TO_EARLIER_PROOF':
      return 'Photo très ressemblante à la preuve d’une autre intervention.';
    case 'BLANK_PHOTO':
      return 'Photo presque uniforme (objectif couvert ou image noire).';
    case 'JOB_NOT_LOCATED':
      return 'Adresse de l’intervention sans coordonnées: position non vérifiable.';
    default:
      return reason;
  }
}
