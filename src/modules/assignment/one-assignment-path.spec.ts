import { readFileSync } from 'fs';
import { join } from 'path';

import {
  balanced,
  listSourceFiles,
  readSource,
  stripComments,
  valueOfKey,
} from '../../common/testing/source-scan';

/**
 * P1-05 guard: an artisan is given a job in ONE place (AssignmentService.assign),
 * and the availability of an artisan is read by ONE rule.
 *
 * It reads the source. The admin route, the matching, the scheduling and the
 * general update of an intervention each used to carry their own copy of the
 * checks (one looked at the approval only, one at the time only, one at nothing);
 * this fails if a copy comes back. A text scan, not a type check: it stops
 * mistakes, not someone determined.
 */

/** Files that may write an artisan onto a job, and why. */
const MAY_WRITE_ARTISAN: Record<string, string> = {
  'modules/assignment/assignment.service.ts': 'the assignment itself',
  'modules/artisans/artisans.service.ts':
    'an artisan takes an open mission (compare-and-set, approved artisans only) or gives it back',
};

/** `data` that is a variable, and why it holds no artisan. */
const REVIEWED_DATA_VARIABLES = new Set([
  // the status helper builds its own columns
  'modules/intervention-workflow/transition-status.ts',
  // changeStatus passes { note } only; applyTransition callers pass literals (scanned below)
  'modules/intervention-workflow/intervention-workflow.service.ts',
  // update(): the artisan was taken out of the DTO and handled by the assignment first
  'modules/interventions/interventions.service.ts',
]);

const WRITE_CALLS =
  /\b(transitionStatusDetailed|transitionStatus|applyTransition|intervention\.(?:update|updateMany|upsert|create|createMany))\s*\(/g;

const WRITES_ARTISAN = /\bartisanId\b|\bartisan\s*:\s*\{/;

/** `data,` written as a shorthand at the top level of an object literal. */
function hasShorthand(body: string, key: string): boolean {
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch)) depth--;

    if (depth !== 0) continue;

    if (new RegExp(`^${key}\\s*(,|$|\\n)`).test(body.slice(i)) && /[\s,{]/.test(i === 0 ? ' ' : body[i - 1])) {
      return true;
    }
  }

  return false;
}

type Scan = { writers: Set<string>; unreviewed: string[]; calls: number };

export function scanArtisanWrites(rel: string, source: string, into: Scan) {
  const text = stripComments(source);
  let match: RegExpExecArray | null;

  WRITE_CALLS.lastIndex = 0;

  while ((match = WRITE_CALLS.exec(text))) {
    const name = match[1];
    const args = balanced(text, match.index + match[0].length - 1);
    const open = args.indexOf('{');

    if (name === 'applyTransition') {
      // applyTransition(id, status, userId, { ...data })
      const last = args.lastIndexOf('{');
      if (last > -1 && WRITES_ARTISAN.test(balanced(args, last))) into.writers.add(rel);
      into.calls++;
      continue;
    }

    // The definitions themselves ("async transitionStatus(db, input)") are not calls.
    if (/\b(function|async)\s+$/.test(text.slice(Math.max(0, match.index - 10), match.index))) continue;

    into.calls++;

    if (open < 0) {
      if (!REVIEWED_DATA_VARIABLES.has(rel)) into.unreviewed.push(`${rel}: ${name}() without an object literal`);
      continue;
    }

    const body = balanced(args, open);

    for (const key of ['data', 'dataOnChange', 'create', 'update']) {
      const value = valueOfKey(body, key);

      if (!value) {
        if ((key === 'data' || key === 'dataOnChange') && hasShorthand(body, key) && !REVIEWED_DATA_VARIABLES.has(rel)) {
          into.unreviewed.push(`${rel}: ${name}() with \`${key}\` from a variable`);
        }
        continue;
      }

      if (!value.literal) {
        if (!REVIEWED_DATA_VARIABLES.has(rel)) {
          into.unreviewed.push(`${rel}: ${name}() with \`${key}: ${value.text}\``);
        }
        continue;
      }

      if (WRITES_ARTISAN.test(value.text)) into.writers.add(rel);
    }
  }
}

function scanAll(): Scan {
  const into: Scan = { writers: new Set(), unreviewed: [], calls: 0 };

  for (const rel of listSourceFiles()) scanArtisanWrites(rel, readSource(rel), into);

  return into;
}

describe('an artisan is put on a job in one place', () => {
  it('the scanner finds the writes it is supposed to check', () => {
    expect(scanAll().calls > 15).toBe(true);
  });

  it('only the assignment, and the artisan taking or giving back an open mission, write the artisan', () => {
    expect([...scanAll().writers].sort()).toEqual(Object.keys(MAY_WRITE_ARTISAN).sort());
  });

  it('no write hides its data in a variable nobody reviewed', () => {
    expect(scanAll().unreviewed).toEqual([]);
  });

  it.each([
    'modules/admin/admin.service.ts',
    'modules/matching/matching.service.ts',
    'modules/scheduling/scheduling.service.ts',
    'modules/interventions/interventions.service.ts',
  ])('%s gives a job to an artisan through AssignmentService.assign, and has no copy of it', (rel) => {
    const text = stripComments(readSource(rel));

    expect(text.includes('this.assignment.assign(')).toBe(true);
    // The old copies booked the appointment and stamped the assignment themselves.
    expect(/\bscheduledById\b/.test(text)).toBe(false);
    expect(/\bassignedAt\b/.test(text)).toBe(false);
  });

  it('the general update goes to the assignment before it builds the columns to write', () => {
    const text = stripComments(readSource('modules/interventions/interventions.service.ts'));
    const marker = 'const { artisanId, status, ...rest } = updateInterventionDto;';
    const assign = text.indexOf('this.assignment.assign(');
    const columns = text.indexOf('const data: Record<string, unknown> = { ...rest };');

    expect(readSource('modules/interventions/interventions.service.ts').includes(marker)).toBe(true);
    expect(assign > 0 && columns > 0 && assign < columns).toBe(true);
  });

  describe('the scanner catches the ways of writing an artisan', () => {
    const writers = (rel: string, code: string) => {
      const into: Scan = { writers: new Set(), unreviewed: [], calls: 0 };
      scanArtisanWrites(rel, code, into);
      return { writers: [...into.writers], unreviewed: into.unreviewed };
    };

    it('a status change that carries the artisan', () => {
      expect(
        writers('x.ts', `await transitionStatus(this.prisma, { id, to: Status.ASSIGNED, data: { artisanId, assignedAt: now } });`).writers,
      ).toEqual(['x.ts']);
    });

    it('a plain update, a nested relation, a computed object', () => {
      expect(writers('x.ts', `await this.prisma.intervention.update({ where: { id }, data: { artisanId: 4 } });`).writers).toEqual(['x.ts']);
      expect(
        writers('x.ts', `await this.prisma.intervention.update({ where: { id }, data: { artisan: { connect: { id: 4 } } } });`).writers,
      ).toEqual(['x.ts']);
      expect(
        writers('x.ts', `await transitionStatusDetailed(tx, { id, to, dataOnChange: { artisanId: 4 } });`).writers,
      ).toEqual(['x.ts']);
    });

    it('data from a variable or a shorthand', () => {
      expect(writers('x.ts', `await this.prisma.intervention.update({ where: { id }, data: payload });`).unreviewed.length).toBe(1);
      expect(writers('x.ts', `await transitionStatusDetailed(tx, { id, to, data, include });`).unreviewed.length).toBe(1);
    });

    it('an applyTransition with the artisan', () => {
      expect(writers('x.ts', `await this.applyTransition(id, Status.ASSIGNED, userId, { artisanId, assignedAt: new Date() });`).writers).toEqual(['x.ts']);
    });

    it('while the normal code passes', () => {
      const ok = writers(
        'x.ts',
        `// artisanId: 4 in a comment\nawait this.prisma.intervention.update({ where: { artisanId: userId }, data: { rating: 5 } });`,
      );

      expect(ok.writers).toEqual([]);
      expect(ok.unreviewed).toEqual([]);
    });
  });
});

describe('the availability of an artisan is read by one rule', () => {
  const matching = stripComments(readSource('modules/matching/matching.service.ts'));
  const scheduling = stripComments(readSource('modules/scheduling/scheduling.service.ts'));

  it('the matching and the scheduling read the weekly hours with the shared function', () => {
    expect(matching.includes('checkWeeklySchedule(')).toBe(true);
    expect(scheduling.includes('checkWeeklySchedule(')).toBe(true);
  });

  it('neither has its own copy: no weekday from the server clock, no hours from the UTC clock', () => {
    for (const text of [matching, scheduling]) {
      expect(/\.getDay\(\)/.test(text)).toBe(false);
      expect(/toISOString\(\)\.slice\(11/.test(text)).toBe(false);
      expect(/jsDayToDayOfWeek|timeFromDate/.test(text)).toBe(false);
    }
  });

  it('the matching decides who is free with the shared issues, not with its own conditions', () => {
    expect(matching.includes('artisanAvailabilityIssues(')).toBe(true);
    expect(/hardIssues\.push\(\s*'Artisan/.test(matching)).toBe(false);
  });

  it('the appointments that hold an artisan\'s time (a request to cancel included), and the jobs that count against the maximum, are listed once', () => {
    const trio = /AppointmentStatus\.SCHEDULED[\s,]+AppointmentStatus\.CONFIRMED[\s,]+AppointmentStatus\.RESCHEDULE_REQUESTED/;
    const owners = listSourceFiles().filter((rel) => trio.test(stripComments(readSource(rel))));

    expect(owners).toEqual(['modules/assignment/artisan-availability.ts']);
    expect(/Status\.PAYMENT_PENDING,\s*\n\s*\n?\s*\/\/ Old compatibility/.test(matching)).toBe(false);
  });

  it('the preferred hours of a client are read on the clock of the business, like the weekly hours', () => {
    expect(matching.includes('zonedInstant(')).toBe(true);
    expect(/T\$\{preferred(Start|End)Time\}:00\.000Z/.test(matching)).toBe(false);
  });
});

describe('one artisan calendar, one lock (P1-05 review)', () => {
  const scheduling = stripComments(readSource('modules/scheduling/scheduling.service.ts'));
  const assignment = stripComments(readSource('modules/assignment/assignment.service.ts'));

  it('the statement that takes the lock is written once, as a transaction-level lock', () => {
    const owners = listSourceFiles().filter((rel) => /pg_advisory_(xact_)?lock|pg_try_advisory/.test(stripComments(readSource(rel))));

    expect(owners).toEqual(['modules/assignment/artisan-lock.ts']);
    expect(/pg_advisory_xact_lock\(\$\{LOCK_ARTISAN\}/.test(readSource('modules/assignment/artisan-lock.ts'))).toBe(true);
    expect(/pg_advisory_lock|pg_try_advisory/.test(readSource('modules/assignment/artisan-lock.ts').replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });

  it('the assignment takes the job lock first and the artisan lock second', () => {
    const job = assignment.indexOf('lockJob(tx');
    const artisan = assignment.indexOf('lockArtisanCalendar(tx');

    expect(job > 0 && artisan > job).toBe(true);
  });

  it('the approval of a new time and a block of unavailable time take the same lock, and look inside the transaction that holds it', () => {
    expect((scheduling.match(/lockArtisanCalendar\(tx/g) ?? []).length).toBe(2);
    expect((scheduling.match(/this\.checkDoubleBooking\(\{[^}]*\bdb: tx/g) ?? []).length).toBe(2);
    expect(/this\.checkDoubleBooking\(\{(?![^}]*\bdb:)/.test(scheduling)).toBe(false);
  });
});

describe('an artisan the back office makes or approves can be given a job (P1-05 review)', () => {
  it('"create an artisan" and "approve an application" make the profile with the account', () => {
    for (const rel of ['modules/users/users.service.ts', 'modules/artisan-applications/artisan-applications.service.ts']) {
      const text = stripComments(readSource(rel));

      expect(text.includes('approvedProfileData(')).toBe(true);
      expect(/tx\.artisanProfile\.create\(/.test(text)).toBe(true);
    }
  });

  it('every approval by the back office switches missions on: manual creation, approval, reactivation', () => {
    const admin = stripComments(readSource('modules/admin/admin.service.ts'));
    const approvals = admin.match(/verificationStatus:\s*ArtisanVerificationStatus\.APPROVED[\s\S]{0,260}?\}/g) ?? [];

    const writes = approvals.filter((block) => /verifiedAt|rejectionReason/.test(block)); // not the dashboard counter's "where"

    expect(writes.length).toBe(3); // manual creation, approval, reactivation
    expect(writes.filter((block) => /isAcceptingJobs:\s*true/.test(block)).length).toBe(3);
    // urgent jobs too for a new approval (not for a reactivation: what the artisan chose stays)
    expect(writes.filter((block) => /emergencyAvailable:\s*true/.test(block)).length).toBe(2);
  });

  it('the urgent-jobs flag and the maximum of jobs can be changed: by the back office, and the flag by the artisan', () => {
    const admin = readSource('modules/admin/dto/admin.dto.ts');
    const edit = admin.slice(admin.indexOf('export class EditArtisanProfileDto'));
    const editOnly = edit.slice(0, edit.indexOf('\nexport class ', 10));

    expect(/emergencyAvailable\?: boolean;/.test(editOnly)).toBe(true);
    expect(/maxActiveJobs\?: number;/.test(editOnly)).toBe(true);
    expect(/emergencyAvailable\?: boolean;/.test(readSource('modules/artisans/dto/update-artisan-profile.dto.ts'))).toBe(true);
  });
});


describe('a rewritten appointment, an answered request, the landing status (P1-05 second review)', () => {
  const scheduling = stripComments(readSource('modules/scheduling/scheduling.service.ts'));
  const assignment = stripComments(readSource('modules/assignment/assignment.service.ts'));
  const review = scheduling.slice(scheduling.indexOf('async reviewAppointmentRequest('));
  const reviewOnly = review.slice(0, review.indexOf('\n  // ====='));

  it('a request about an appointment is answered under the job lock, from what it says then: refusal, cancellation and move alike', () => {
    expect(/lockJob\(tx, request\.appointment\.interventionId\)/.test(reviewOnly)).toBe(true);
    expect((reviewOnly.match(/await lockedPendingRequest\(tx\)|= await lockedPendingRequest\(tx\)/g) ?? []).length).toBe(3);
    // no answer written beside the transaction that holds the lock
    expect(/this\.prisma\.appointmentRequest\.update/.test(reviewOnly)).toBe(false);
    expect((reviewOnly.match(/tx\.appointmentRequest\.update\(/g) ?? []).length).toBe(3);
  });

  it('an assignment that rewrites or takes away an appointment closes the pending requests about it, in the same transaction', () => {
    const closing = assignment.match(/tx\.appointmentRequest\.updateMany\(\{[\s\S]*?\}\);/)?.[0] ?? '';

    expect(/status:\s*AppointmentRequestStatus\.PENDING/.test(closing)).toBe(true);
    expect(/status:\s*AppointmentRequestStatus\.CANCELLED/.test(closing)).toBe(true);
    expect(/reviewedById:\s*actorId/.test(closing)).toBe(true);
    expect(assignment.indexOf('tx.appointmentRequest.updateMany') < assignment.indexOf('return {\n        row,\n        appointment,')).toBe(true);
  });

  it('an old appointment that is not reused is put in nobody\'s name, never in the new artisan\'s', () => {
    expect(/tx\.appointment\.update\(\{\s*where:\s*\{\s*interventionId\s*\},\s*data:\s*\{\s*artisanId:\s*null\b/.test(assignment)).toBe(true);
    expect(/tx\.appointment\.update\(\{[^}]*\}?[^}]*data:\s*\{\s*artisanId\s*[,}]/.test(assignment)).toBe(false);
  });

  it('the accepted landing is written ACCEPTED, the spelling the deployed apps read as "affecté"', () => {
    expect(/asLanding === 'ARTISAN_ACCEPTED' \? Status\.ACCEPTED : Status\.ASSIGNED/.test(assignment)).toBe(true);
  });

  it('the weekly hours an artisan sends are put in order by the same function in the service', () => {
    expect(/slotOrderProblem\(dto\.slots\)/.test(stripComments(readSource('modules/artisans/artisans.service.ts')))).toBe(true);
  });

  it('the one-off script makes artisans available for urgent jobs only when asked', () => {
    const script = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'backfill-artisan-profiles.ts'), 'utf8');

    expect(/process\.argv\.includes\('--emergency-on'\)/.test(script)).toBe(true);
    expect(/if \(options\.emergencyOn\)/.test(stripComments(readSource('modules/artisans/profile-backfill.ts')))).toBe(true);
  });
});
