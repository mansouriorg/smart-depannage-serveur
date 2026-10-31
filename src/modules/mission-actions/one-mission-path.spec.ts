import { balanced, listSourceFiles, readSource, stripComments } from '../../common/testing/source-scan';

/**
 * P1-06 guard: what an artisan does with a mission (accept, give back, on the way,
 * arrived) happens in ONE place, MissionActionsService, and each action is made
 * the same way: under the lock of the job, through the status table, and its
 * aftermath (timeline, people, live event) can fail without undoing it.
 *
 * It reads the source: a text scan that stops mistakes, not someone determined.
 */

const service = () => stripComments(readSource('modules/mission-actions/mission-actions.service.ts'));
const artisans = () => stripComments(readSource('modules/artisans/artisans.service.ts'));

/** The body of `name(...) {...}` in a source text. */
function bodyOf(source: string, name: string): string {
  const found = new RegExp(`\\b${name}\\s*\\(`).exec(source);

  if (!found) return '';

  const parenthesis = found.index + found[0].length - 1;
  const params = balanced(source, parenthesis);
  const open = source.indexOf('{', parenthesis + params.length + 2);

  return balanced(source, open);
}

/** Does a call `intervention.update(...)` or `updateMany(...)` put `status` among the columns it writes? */
function writesStatusDirectly(source: string): boolean {
  for (const call of source.matchAll(/intervention\.(?:update|updateMany)\(/g)) {
    const body = balanced(source, (call.index ?? 0) + call[0].length - 1);
    const data = /\bdata\s*:\s*\{/.exec(body);

    if (!data) continue;

    const written = balanced(body, data.index + data[0].length - 1);

    if (/\bstatus\b\s*[:,}]/.test(written)) return true;
  }

  return false;
}

describe('the artisan\'s mission actions are made in one place (P1-06)', () => {
  it('the four routes of the artisans service only hand over to MissionActionsService', () => {
    for (const [name, call] of [
      ['acceptMission', 'accept'],
      ['rejectMission', 'decline'],
      ['markOnTheWay', 'onTheWay'],
      ['markArrived', 'arrived'],
    ]) {
      const body = bodyOf(artisans(), name);

      expect(body.includes(`this.missionActions.${call}(`)).toBe(true);
      expect(/transitionStatus|\.sendSms\(|\.intervention\.|artisanMissionRejection|createMissionEvent/.test(body)).toBe(false);
    }
  });

  it('no other file records a refusal, or tells the people about these steps', () => {
    const offenders: string[] = [];

    for (const rel of listSourceFiles()) {
      if (rel === 'modules/mission-actions/mission-actions.service.ts') continue;

      const text = stripComments(readSource(rel));

      if (/artisanMissionRejection\.(create|update|upsert|delete)/.test(text)) offenders.push(`${rel}: writes a refusal`);

      if (rel !== 'modules/notifications/notifications.service.ts' && /notifyArtisan(AcceptedMission|OnTheWay|Arrived|Declined)\(/.test(text)) {
        offenders.push(`${rel}: tells the people about a mission step`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every transaction takes the lock of the job before it reads the job', () => {
    const text = service();
    const transactions = text.split('this.prisma.$transaction(').slice(1);

    expect(transactions.length).toBe(3); // accept, advance (on the way / arrived), decline

    for (const part of transactions) {
      const first = part.slice(0, part.indexOf('await lockJob(tx, interventionId);') + 40);

      expect(first.includes('await lockJob(tx, interventionId);')).toBe(true);
      expect(/tx\.intervention\.findUnique/.test(first)).toBe(false);
    }
  });

  it('the lock of the artisan\'s calendar comes after the job\'s, and only where an open mission is taken', () => {
    const text = service();

    expect(text.indexOf('await lockJob(tx, interventionId)') < text.indexOf('await lockArtisanCalendar(tx, userId)')).toBe(true);
    expect((text.match(/lockArtisanCalendar\(/g) ?? []).length).toBe(1);
    expect(/if \(!holds\) \{[^}]*lockArtisanCalendar/.test(text)).toBe(true);
  });

  it('every status is written by the status table, as the artisan', () => {
    const text = service();
    const writes = text.match(/transitionStatusDetailed\(tx,\s*\{/g) ?? [];

    expect(writes.length).toBe(3);
    expect((text.match(/actor:\s*\{\s*kind:\s*'artisan',\s*userId\s*\}/g) ?? []).length).toBe(3);
    expect(writesStatusDirectly(text)).toBe(false);
    expect(/kind:\s*'staff'/.test(text)).toBe(false);
  });

  it('the scan for a status written around the table sees both shapes of an update (it must not pass for nothing)', () => {
    expect(writesStatusDirectly('tx.intervention.update({ data: { status: 1 }, where: { id } })')).toBe(true);
    expect(writesStatusDirectly('tx.intervention.update({ where: { id }, data: { artisanId: 2, status: 1 } })')).toBe(true);
    expect(writesStatusDirectly('this.prisma.intervention.updateMany({ where: { id }, data: { status: Status.X } })')).toBe(true);
    expect(writesStatusDirectly('tx.intervention.update({ where: { id, status: 1 }, data: { artisanRejectedAt: now } })')).toBe(false);
    expect(writesStatusDirectly('tx.intervention.update({ where: { id }, data: { artisanRejectedAt: now } })')).toBe(false);
  });

  it('what follows an action is one `after` call, run only when something changed, and each part alone', () => {
    const text = service();

    expect((text.match(/await this\.after\(/g) ?? []).length).toBe(3);
    expect((text.match(/if \(done\.(changed|returnedToQueue)\) \{/g) ?? []).length).toBe(3);

    const after = bodyOf(text, 'private async after');

    expect((after.match(/await this\.attempt\(/g) ?? []).length).toBe(3);

    // Outside `after`, the timeline and the live event are not touched, and the people are
    // only named in a `notify: () => ...` that `after` runs inside its own `attempt`. The one
    // exception is the artisan leaving the live room, which is also made inside an `attempt`.
    const outside = text.replace(after, '').replace(/this\.realtime\.removeFromJobRoom\(/g, 'ROOM(');

    expect(/this\.(events|realtime)\.\w+\(/.test(outside)).toBe(false);

    for (const call of outside.matchAll(/this\.notifications\./g)) {
      expect(outside.slice(Math.max(0, (call.index ?? 0) - 300), call.index).includes('notify: () =>')).toBe(true);
    }
  });

  it('the artisan leaves the live room of the job after the commit and before anything is said about the job', () => {
    const decline = bodyOf(service(), 'async decline');
    const commit = decline.indexOf('this.prisma.$transaction(');
    const leaves = decline.indexOf('this.realtime.removeFromJobRoom(userId, interventionId)');
    const says = decline.indexOf('await this.after(');

    expect(leaves > commit).toBe(true);
    expect(leaves < says).toBe(true);
    expect(/await this\.attempt\('removal from the live room'/.test(decline)).toBe(true);
    // Only two things make an artisan leave: giving the job back, and the next artisan taking a job
    // that still carried the id of the first. The steps keep the artisan in.
    expect((service().match(/removeFromJobRoom\(/g) ?? []).length).toBe(2);
    expect(/removeFromJobRoom\(/.test(bodyOf(service(), 'private async advance'))).toBe(false);
  });

  it('the artisan a job was taken from leaves the live room when the next one takes it, after the commit and before anything is said', () => {
    const accept = bodyOf(service(), 'async accept');
    const commit = accept.indexOf('this.prisma.$transaction(');
    const leaves = accept.indexOf('this.realtime.removeFromJobRoom(left, interventionId)');
    const says = accept.indexOf('await this.after(');

    expect(leaves > commit).toBe(true);
    expect(leaves < says).toBe(true);
    expect(/await this\.attempt\('removal of the previous artisan from the live room'/.test(accept)).toBe(true);
    // Only for an artisan who is not the one taking it.
    expect(/!holds && job\.artisanId && job\.artisanId !== userId/.test(accept)).toBe(true);
  });

  it('a job in the queue with the id of an artisan is open: for the claim, for the board and for the details', () => {
    const jobOf = bodyOf(service(), 'private async jobOf');
    const accept = bodyOf(service(), 'async accept');
    const details = bodyOf(artisans(), 'async getMissionDetails');
    const lookup = bodyOf(artisans(), 'private async getMissionForArtisan');

    expect(/!isOpenJob\(job\) && job\.artisanId !== userId/.test(jobOf)).toBe(true);
    // The claim compares with the very id it read, and starts the road from the beginning.
    expect(/artisanId:\s*job\.artisanId as number/.test(accept)).toBe(true);
    expect(/artisanOnTheWayAt:\s*null,\s*artisanArrivedAt:\s*null/.test(accept)).toBe(true);
    expect(/const open = isOpenJob\(mission\)/.test(details)).toBe(true);
    expect(/isOpenJob\(intervention\)/.test(lookup)).toBe(true);
    expect(/mission\.artisanId !== userId/.test(details)).toBe(false);
  });

  it('what an open mission shows has no way to reach the client: on the board and in the details', () => {
    const board = bodyOf(artisans(), 'async getMissionBoard');
    const details = bodyOf(artisans(), 'async getMissionDetails');
    const open = bodyOf(artisans(), 'private asOpenMission');

    expect(/this\.asOpenMission\(job\)/.test(board)).toBe(true);
    expect(/this\.asOpenMission\(/.test(details)).toBe(true);
    expect(/forMarketplace\(/.test(open)).toBe(true);
    expect(/client:\s*job\.client \? \{ name: job\.client\.name \}/.test(open)).toBe(true);
    expect(/payments:\s*\[\]/.test(open) && /invoice:\s*null/.test(open)).toBe(true);
  });

  it('no route of the artisan hands back a whole row of the job (the notes of the back office stay on the server)', () => {
    // The routes on a mission (start the work … report a problem), not the review of an application.
    const whole = artisans();
    const text = whole.slice(whole.indexOf('async startIntervention('), whole.indexOf('async contactClient('));

    expect(text.length > 1000).toBe(true);
    expect(/return updated;/.test(text)).toBe(false);
    expect(/return this\.prisma\.intervention\.update\(/.test(text)).toBe(false);
    expect(/return this\.prisma\.intervention\.updateMany\(/.test(text)).toBe(false);
  });

  it('the timeline line of a refusal is the one line that is not signed', () => {
    const text = service();

    expect((text.match(/anonymous:\s*true/g) ?? []).length).toBe(1);
    expect(bodyOf(text, 'async decline').includes('anonymous: true')).toBe(true);
    expect(/createdById:\s*params\.anonymous \? undefined : userId/.test(bodyOf(text, 'private async after'))).toBe(true);
  });

  it('the people are told through the notification service, not by a text sent from here', () => {
    expect(/sendSms|sendEmail|sendPush/.test(service())).toBe(false);
    expect(/sendSms/.test(bodyOf(artisans(), 'markOnTheWay'))).toBe(false);
  });

  it('the timeline of a refusal carries neither the reason nor the note (the client reads the timeline)', () => {
    const decline = bodyOf(service(), 'async decline');
    const timeline = decline.slice(decline.indexOf('timeline:'), decline.indexOf('notify:'));

    expect(timeline.includes('Artisan indisponible')).toBe(true);
    expect(/reason|note/.test(timeline)).toBe(false);
  });

  it('giving a mission back frees the visit in the same transaction, with the shared helpers of the assignment', () => {
    const decline = bodyOf(service(), 'async decline');
    const release = bodyOf(service(), 'private async releaseVisit');

    expect(decline.indexOf('this.releaseVisit(tx, visit') > decline.indexOf('transitionStatusDetailed(tx')).toBe(true);
    expect(/visit\.artisanId === userId/.test(decline)).toBe(true);

    expect(release.indexOf('detachAppointment(tx, visit') >= 0).toBe(true);
    expect(release.indexOf('closePendingRequests(tx, visit.id') > release.indexOf('detachAppointment(tx')).toBe(true);
    expect(/replaceDefaultReminders\(tx,\s*\{\s*\.\.\.visit,\s*startsAt:\s*null\s*\}\)/.test(release)).toBe(true);
  });

  it('taking an open mission refuses a visit still to come and frees one left in another artisan\'s name', () => {
    const accept = bodyOf(service(), 'async accept');
    const mayTake = bodyOf(service(), 'private async assertMayTake');

    expect(/isCurrentVisit\(visit\)/.test(mayTake)).toBe(true);
    expect(/visit\.artisanId !== null && visit\.artisanId !== userId/.test(accept)).toBe(true);
    expect(accept.indexOf('this.releaseVisit(tx, visit') > accept.indexOf('transitionStatusDetailed(tx')).toBe(true);
  });

  it('"mine" is an artisan who has the job in their hands, never the id alone', () => {
    const text = service();

    expect(/job\.artisanId === userId\s*&&\s*HELD\.includes\(/.test(bodyOf(text, 'private holds'))).toBe(true);
    expect(/const mine\b/.test(text)).toBe(false);
    expect((text.match(/this\.holds\(job, userId\)/g) ?? []).length).toBe(2); // accept, decline
  });

  it('what is handed back to an artisan has no column of the back office', () => {
    const text = service();

    expect(/withoutStaffFields\(row\)/.test(bodyOf(text, 'private forTheArtisan'))).toBe(true);
    expect((text.match(/return this\.forTheArtisan\(done\.row\)/g) ?? []).length).toBe(2); // accept, advance
  });

  it('the board and the matching leave out a refusal; the assignment does not read it', () => {
    expect(/missionRejections:\s*\{\s*none:\s*\{\s*artisanProfileId:\s*profile\.id\s*\}\s*\}/.test(artisans())).toBe(true);
    expect(/missionRejections/.test(stripComments(readSource('modules/assignment/assignment.service.ts')))).toBe(false);
  });

  it('the route an artisan used before hands the step to the mission service, and the update that did the other steps is gone (P3-03)', () => {
    const scheduling = stripComments(readSource('modules/scheduling/scheduling.service.ts'));
    const interventions = stripComments(readSource('modules/interventions/interventions.service.ts'));

    expect(/this\.missionActions\.accept\(/.test(bodyOf(scheduling, 'async acceptScheduledMission'))).toBe(true);

    // PATCH /interventions/:id (the artisan's "on the way" and "arrived") was deleted: the phone app uses /artisans/me/missions/... now,
    // and the interventions service neither holds the mission service nor writes a step of the road to the job.
    expect(/\bupdateAsArtisan\b/.test(interventions)).toBe(false);
    expect(/\bmissionActions\b|\bMissionActionsService\b/.test(interventions)).toBe(false);
  });

  it('only the mission service (an artisan) and the staff workflow write the dates of the road to the job', () => {
    const allowed = [
      'modules/mission-actions/mission-actions.service.ts',
      // Back-office only (its routes are for ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER).
      'modules/intervention-workflow/intervention-workflow.service.ts',
      // Names the columns to say who may read them (P1-08); writes nothing.
      'common/views/intervention-columns.ts',
      // Names the columns the back office's case file shows (P1-14); a pure view, writes nothing.
      'common/views/case-file.ts',
    ];
    const offenders = listSourceFiles().filter(
      (rel) => !allowed.includes(rel) && /artisanOnTheWayAt|artisanArrivedAt/.test(stripComments(readSource(rel))),
    );

    expect(offenders).toEqual([]);
  });
});
