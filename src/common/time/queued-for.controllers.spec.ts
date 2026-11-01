import { ArtisansController } from '../../modules/artisans/artisans.controller';
import { InterventionsController } from '../../modules/interventions/interventions.controller';
import { ProofsController } from '../../modules/proofs/proofs.controller';
import { readSource, stripComments } from '../testing/source-scan';
import { MAX_QUEUED_FOR_SECONDS, QUEUED_FOR_HEADER } from './queued-for';

/** The text of one method of a controller, from its name to the end of its body. */
function methodText(rel: string, name: string): string {
  const source = stripComments(readSource(rel));
  const start = source.search(new RegExp(`\\n  (async )?${name}\\(`));

  expect(start).toBeGreaterThan(0);

  return source.slice(start, source.indexOf('\n  }\n', start));
}

/**
 * The routes that take an action the phone held read the header `X-Queued-For` and give the service the number of seconds, read leniently (P3-06).
 */
function artisansWorld() {
  const calls: Array<{ name: string; args: any[] }> = [];
  const record = (name: string) => (...args: any[]) => (calls.push({ name, args }), { from: name });
  const service: any = { markOnTheWay: record('markOnTheWay'), markArrived: record('markArrived'), startIntervention: record('startIntervention') };

  return { controller: new ArtisansController(service), calls };
}

describe('the jobs read before a held action is dated ask for the moments of the road (P3-06)', () => {
  // The in-memory database of the specs returns whole rows whatever is selected: only the text of the query can show that a real one is asked
  // for the dates that hold an action back.
  it('the mission actions read the job with them', () => {
    const source = stripComments(readSource('modules/mission-actions/mission-actions.service.ts'));

    expect(source).toMatch(/select: \{[^}]*\.\.\.ROAD_MOMENTS_SELECT,[^}]*\}/);
  });

  it('the proof service reads the job with them, twice: to date the closing photo, and to check the photo\'s clock against the same date', () => {
    const source = stripComments(readSource('modules/proofs/proofs.service.ts'));

    expect(source).toMatch(/afterPhotoUrl: true, \.\.\.ROAD_MOMENTS_SELECT \}/);
    // the first read of the job (the one the checks are made on)
    expect(source).toMatch(/savedAddress: \{ select: \{ latitude: true, longitude: true \} \},\s*\.\.\.ROAD_MOMENTS_SELECT,/);
    expect((source.match(/\.\.\.ROAD_MOMENTS_SELECT/g) ?? []).length).toBe(2);
    // and the clock check is made on that same date
    expect(source).toMatch(/receivedAt\.getTime\(\) - whenDoneOnJob\(receivedAt, queuedFor, job\)\.getTime\(\)/);
  });

  it('the start of the work reads the job through the one method that already asks for them', () => {
    const source = stripComments(readSource('modules/artisans/artisans.service.ts'));

    expect(source).toMatch(/const mission = await this\.getMissionForArtisan\(userId, interventionId\);/);
    expect(source).toMatch(/workStartedAt: whenDoneOnJob\(new Date\(\), queuedForSeconds, mission\)/);
  });
});

describe('the three steps of a technician read how long the phone held them (P3-06)', () => {
  it('give the service the figure of the header, in seconds', () => {
    const { controller, calls } = artisansWorld();

    controller.markOnTheWay(4, 12, '3600');
    controller.markArrived(4, 12, '120');
    controller.startIntervention(4, 12, '5');

    expect(calls.map((call) => [call.name, call.args])).toEqual([
      ['markOnTheWay', [4, 12, 3600]],
      ['markArrived', [4, 12, 120]],
      ['startIntervention', [4, 12, 5]],
    ]);
  });

  it('give 0 when the header is missing or cannot be read, and seven days at most', () => {
    const { controller, calls } = artisansWorld();

    controller.markOnTheWay(4, 12);
    controller.markOnTheWay(4, 12, '');
    controller.markOnTheWay(4, 12, 'yesterday');
    controller.markOnTheWay(4, 12, '-30');
    controller.markOnTheWay(4, 12, '9999999999');

    expect(calls.map((call) => call.args[2])).toEqual([0, 0, 0, 0, MAX_QUEUED_FOR_SECONDS]);
  });

  it('declare the header on each of the three routes, with the name the phone sends', () => {
    expect(QUEUED_FOR_HEADER).toBe('x-queued-for');

    for (const method of ['markOnTheWay', 'markArrived', 'startIntervention']) {
      expect(methodText('modules/artisans/artisans.controller.ts', method)).toContain('@Headers(QUEUED_FOR_HEADER) queuedFor?: string');
    }
  });
});

describe('the two routes that take a proof photo read how long the phone held it (P3-06)', () => {
  const file: any = { buffer: Buffer.from('x'), mimetype: 'image/jpeg' };
  const req = { user: { id: 4, role: 'ARTISAN' } };

  it('complete-work gives the service the figure with the photo and what the phone said', async () => {
    const seen: any[] = [];
    const service: any = { completeWork: async (...args: any[]) => (seen.push(args), { ok: true }) };
    const controller = new InterventionsController(service);

    await controller.completeWork(req, '15', file, { latitude: '36.8', timestamp: '2026-11-01T14:02:00Z' } as any, '13200');
    await controller.completeWork(req, '15', file, {} as any);

    expect(seen[0][0]).toBe(15);
    expect(seen[0][2].queuedForSeconds).toBe(13_200);
    expect(seen[0][2].capture).toMatchObject({ latitude: '36.8', capturedAt: '2026-11-01T14:02:00Z' });
    expect(seen[1][2].queuedForSeconds).toBe(0);
  });

  it('the before / after photo route does not read it: the phone keeps nothing but the photo that closes the job', async () => {
    const seen: any[] = [];
    const service: any = { submit: async (input: any) => (seen.push(input), { view: { ok: true } }) };
    const controller = new ProofsController(service);

    await controller.add(req, 15, 'after', file, {} as any);
    await controller.add(req, 15, 'before', file, {} as any);

    expect(seen.map((input) => input.queuedForSeconds)).toEqual([undefined, undefined]);
  });

  it('declare the header on the closing photo route, and only there', () => {
    expect(methodText('modules/interventions/interventions.controller.ts', 'completeWork')).toContain('@Headers(QUEUED_FOR_HEADER) queuedFor?: string');
    expect(readSource('modules/proofs/proofs.controller.ts')).not.toContain('QUEUED_FOR_HEADER');
    expect(readSource('modules/proofs/proofs.controller.ts')).not.toContain('readQueuedFor');
  });
});
