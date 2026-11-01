import { balanced, listSourceFiles, readSource, stripComments, valueOfKey } from '../../common/testing/source-scan';
import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { ArtisansService } from '../artisans/artisans.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { UsersService } from '../users/users.service';

/**
 * Every place that writes a technician's position writes it with its time and in the history (P3-05): the REST route of the phone, the live
 * socket, and the older general route. A position that came from the staff over the socket is the one exception, and is written as it was.
 */

const ARTISAN = 7;

function world(jobStatus: string | null = null) {
  const user = new FakeTable({ defaults: () => ({ role: 'ARTISAN', latitude: null, longitude: null, positionAt: null }) });
  const artisanProfile = new FakeTable({ defaults: () => ({ lastSeenAt: null, availabilityStatus: 'OFFLINE', isAcceptingJobs: false }) });
  const intervention = new FakeTable({ defaults: () => ({ clientId: 10, artisanId: null, status: 'ASSIGNED' }) });
  const artisanLocationPing = new FakeTable({ defaults: () => ({ interventionId: null }) });

  user.insert({ id: ARTISAN, name: 'Sami' });
  user.insert({ id: 90, name: 'Dispatcher', role: 'DISPATCHER' });
  user.insert({ id: 91, name: 'Admin', role: 'ADMIN' });
  artisanProfile.insert({ id: 1, userId: ARTISAN });
  intervention.insert({ id: 40, artisanId: ARTISAN, status: jobStatus ?? 'ARTISAN_ACCEPTED' });

  const prisma: any = withTransactions({ user, artisanProfile, intervention, artisanLocationPing }, [user, artisanProfile, artisanLocationPing]);

  return { prisma, user, artisanProfile, intervention, artisanLocationPing };
}

const artisanRow = (w: ReturnType<typeof world>) => w.user.rows.find((row) => row.id === ARTISAN)!;

describe('the REST route of the phone writes the position, its time and the history (P3-05)', () => {
  const service = (w: ReturnType<typeof world>) => new ArtisansService(w.prisma, {} as any, {} as any, {} as any, {} as any, {} as any);

  it('writes all three together', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const before = Date.now();

    await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18, accuracy: 9, speed: 6, heading: 45 } as any);

    const row = artisanRow(w);

    expect([row.latitude, row.longitude]).toEqual([36.81, 10.18]);
    expect(row.positionAt instanceof Date && row.positionAt.getTime() >= before).toBe(true);
    expect(w.artisanProfile.rows[0].lastSeenAt).toEqual(row.positionAt);
    expect(w.artisanLocationPing.rows.length).toBe(1);
    expect(w.artisanLocationPing.rows[0]).toMatchObject({ artisanId: ARTISAN, interventionId: 40, latitude: 36.81, longitude: 10.18, accuracyMeters: 9, speedMps: 6, heading: 45 });
    expect(w.artisanLocationPing.rows[0].recordedAt).toEqual(row.positionAt);
  });

  it('a position sent while on no job has its time but no row in the history: nothing replays it, so nothing keeps it', async () => {
    const w = world('ARTISAN_ACCEPTED');

    await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18 } as any);

    expect(artisanRow(w).positionAt instanceof Date).toBe(true);
    expect([artisanRow(w).latitude, artisanRow(w).longitude]).toEqual([36.81, 10.18]);
    expect(w.artisanLocationPing.rows.length).toBe(0);
  });

  it('the position, its time and the history row go in one transaction: the three are written together or not at all', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const lists: number[] = [];
    const original = w.prisma.$transaction;

    // The list form of $transaction is all-or-nothing in the database; the stand-in only undoes tables when a callback throws, so the shape is what is checked.
    w.prisma.$transaction = (work: any) => {
      lists.push(Array.isArray(work) ? work.length : -1);

      return original(work);
    };

    await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18 } as any);

    expect(lists).toEqual([3]);
  });

  it('reads only the id of the profile: a phone that sends every 30 seconds does not load documents, zones and bank details', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const asked: any[] = [];
    const original = w.artisanProfile.findUnique.bind(w.artisanProfile);

    w.artisanProfile.findUnique = async (args: any) => {
      asked.push(args);

      return original(args);
    };

    await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18 } as any);

    expect(asked.length).toBe(1);
    expect(asked[0].select).toEqual({ id: true });
    expect(asked[0].include).toBeUndefined();
  });

  it('a technician with no profile is a 404, nothing written', async () => {
    const w = world('ARTISAN_ON_THE_WAY');

    w.artisanProfile.rows.length = 0;

    let status: number | null = null;

    try {
      await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18 } as any);
    } catch (error: any) {
      status = error.getStatus?.() ?? null;
    }

    expect(status).toBe(404);
    expect(artisanRow(w).latitude).toBe(null);
  });

  it('a second position within ten seconds updates the position and its time but adds no row', async () => {
    const w = world('ARTISAN_ON_THE_WAY');

    await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18 } as any);
    await service(w).updateLocation(ARTISAN, { latitude: 36.82, longitude: 10.19 } as any);

    expect(w.artisanLocationPing.rows.length).toBe(1);
    expect([artisanRow(w).latitude, artisanRow(w).longitude]).toEqual([36.82, 10.19]);
  });

  it('a position that is not a place writes nothing at all', async () => {
    const w = world('ARTISAN_ON_THE_WAY');

    for (const bad of [{ latitude: 0, longitude: 0 }, { latitude: 120, longitude: 10 }, { latitude: 36, longitude: 500 }]) {
      let refused = false;

      try {
        await service(w).updateLocation(ARTISAN, bad as any);
      } catch {
        refused = true;
      }

      expect(refused).toBe(true);
    }

    expect(artisanRow(w).latitude).toBe(null);
    expect(artisanRow(w).positionAt).toBe(null);
    expect(w.artisanLocationPing.rows.length).toBe(0);
    expect(w.artisanProfile.rows[0].lastSeenAt).toBe(null);
  });

  it('still leaves the availability alone, as before', async () => {
    const w = world();

    await service(w).updateLocation(ARTISAN, { latitude: 36.81, longitude: 10.18 } as any);

    expect(w.artisanProfile.rows[0].availabilityStatus).toBe('OFFLINE');
    expect(w.artisanProfile.rows[0].isAcceptingJobs).toBe(false);
  });
});

describe('the live socket writes the position of the technician’s own phone as news, and the staff’s as it was (P3-05)', () => {
  function gateway(w: ReturnType<typeof world>) {
    const sent: any[] = [];
    const instance: any = new RealtimeGateway({} as any, w.prisma);

    instance.server = {
      to() {
        const chain: any = { to: () => chain, emit: (event: string, payload: any) => sent.push({ event, payload }) };

        return chain;
      },
    };

    return { instance, sent };
  }

  const socketOf = (id: number, role: string): any => ({ data: { user: { id, role } } });
  const message = { interventionId: 40, latitude: 36.81, longitude: 10.18, accuracy: 7, speed: 5, heading: 180 };

  it('the technician: the position, its time and the history row of the job', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const { instance, sent } = gateway(w);

    const answer = await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), message);

    expect(answer.success).toBe(true);
    expect(artisanRow(w).positionAt instanceof Date).toBe(true);
    expect(w.artisanProfile.rows[0].lastSeenAt).toEqual(artisanRow(w).positionAt);
    expect(w.artisanLocationPing.rows.length).toBe(1);
    expect(w.artisanLocationPing.rows[0]).toMatchObject({ artisanId: ARTISAN, interventionId: 40, latitude: 36.81, longitude: 10.18, accuracyMeters: 7, speedMps: 5, heading: 180 });
    expect(answer.payload.updatedAt).toEqual(artisanRow(w).positionAt);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('the customer’s room is told the position of the technician’s phone while on the way, and never one the staff typed in; the back office is told both', async () => {
    for (const [id, role, customerHears] of [[ARTISAN, 'ARTISAN', true], [90, 'DISPATCHER', false], [91, 'ADMIN', false]] as const) {
      const w = world('ARTISAN_ON_THE_WAY');
      const { instance, sent } = gateway(w);

      await instance.updateArtisanLocation(socketOf(id, role), message);

      expect(`${role} room: ${sent.some((item: any) => item.event === 'artisan.location.updated')}`).toBe(`${role} room: ${customerHears}`);
      expect(`${role} back office: ${sent.some((item: any) => item.event === 'admin.artisan.location.updated')}`).toBe(`${role} back office: true`);
    }
  });

  it('the answer and the room are told the time that was written, not the time the answer was made', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const { instance, sent } = gateway(w);
    const RealDate = Date;
    let ticks = 0;

    // every `new Date()` is five seconds later than the one before, so a time taken a second time cannot be the first
    class SteppingDate extends RealDate {
      constructor(...args: any[]) {
        super(...((args.length ? args : [RealDate.UTC(2026, 10, 1, 10, 0, 0) + 5000 * (ticks += 1)]) as [any]));
      }
    }

    (globalThis as any).Date = SteppingDate;

    let answer: any;

    try {
      answer = await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), message);
    } finally {
      (globalThis as any).Date = RealDate;
    }

    const written = artisanRow(w).positionAt as Date;

    expect(written instanceof RealDate).toBe(true);
    expect(answer.payload.updatedAt.getTime()).toBe(written.getTime());
    expect(sent.every((item: any) => new RealDate(item.payload.updatedAt).getTime() === written.getTime())).toBe(true);
  });

  it('the staff: the position is written as before, but it is not news from the phone and is not in the history', async () => {
    for (const [id, role] of [[90, 'DISPATCHER'], [91, 'ADMIN']] as const) {
      const w = world('ARTISAN_ON_THE_WAY');
      const { instance } = gateway(w);

      const answer = await instance.updateArtisanLocation(socketOf(id, role), message);

      expect(answer.success).toBe(true);
      expect([artisanRow(w).latitude, artisanRow(w).longitude]).toEqual([36.81, 10.18]);
      expect(`${role}: ${artisanRow(w).positionAt}`).toBe(`${role}: null`);
      expect(w.artisanProfile.rows[0].lastSeenAt).toBe(null);
      expect(w.artisanLocationPing.rows.length).toBe(0);
    }
  });

  it('the staff’s position does not keep the older time of the phone: coordinates the phone never sent are not called fresh', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const { instance } = gateway(w);

    await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), message);

    expect(artisanRow(w).positionAt instanceof Date).toBe(true);

    await instance.updateArtisanLocation(socketOf(90, 'DISPATCHER'), { ...message, latitude: 36.9, longitude: 10.3 });

    expect([artisanRow(w).latitude, artisanRow(w).longitude]).toEqual([36.9, 10.3]);
    expect(artisanRow(w).positionAt).toBe(null);
    expect(w.artisanLocationPing.rows.length).toBe(1);
  });

  it('the position, its time and the history row go in one transaction, as many as there are to write', async () => {
    const lists: Record<string, number[]> = {};

    for (const [label, id, role, status] of [
      ['the technician, on a job', ARTISAN, 'ARTISAN', 'ARTISAN_ON_THE_WAY'],
      ['the technician, on no job', ARTISAN, 'ARTISAN', 'ARTISAN_ACCEPTED'],
      ['the staff', 90, 'DISPATCHER', 'ARTISAN_ON_THE_WAY'],
    ] as const) {
      const w = world(status);
      const { instance } = gateway(w);
      const original = w.prisma.$transaction;

      lists[label] = [];
      w.prisma.$transaction = (work: any) => {
        lists[label].push(Array.isArray(work) ? work.length : -1);

        return original(work);
      };

      await instance.updateArtisanLocation(socketOf(id, role), message);
    }

    // position + last seen + history; position + last seen; the position alone
    expect(lists).toEqual({ 'the technician, on a job': [3], 'the technician, on no job': [2], 'the staff': [1] });
  });

  it('a half reading is not a place: null, an empty text, false or a list are not zero', async () => {
    for (const bad of [
      { latitude: null, longitude: 10.18 },
      { latitude: 36.81, longitude: null },
      { latitude: '', longitude: 10.18 },
      { latitude: '  ', longitude: 10.18 },
      { latitude: false, longitude: 10.18 },
      { latitude: [], longitude: 10.18 },
      { latitude: {}, longitude: 10.18 },
      { latitude: undefined, longitude: undefined },
      { latitude: 36.81, longitude: 0 + NaN },
    ]) {
      const w = world('ARTISAN_ON_THE_WAY');
      const { instance, sent } = gateway(w);
      let error: any;

      try {
        await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), { ...message, ...bad } as any);
      } catch (caught) {
        error = caught;
      }

      expect(`${JSON.stringify(bad)}: ${String(error?.message ?? error)}`).toMatch(/Invalid GPS coordinates/);
      expect(artisanRow(w).latitude).toBe(null);
      expect(w.artisanLocationPing.rows.length).toBe(0);
      expect(sent).toEqual([]);
    }
  });

  it('a number written as text is still read as the number', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const { instance } = gateway(w);

    await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), { ...message, latitude: '36.81', longitude: ' 10.18 ' } as any);

    expect([artisanRow(w).latitude, artisanRow(w).longitude]).toEqual([36.81, 10.18]);
  });

  it('what is sent to the customer’s room and the dashboard has the accuracy, speed and heading only when they are possible', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const { instance, sent } = gateway(w);

    await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), { ...message, accuracy: -5, speed: 'fast', heading: 999 } as any);

    const payload = sent[0].payload;

    expect([payload.accuracy, payload.speed, payload.heading]).toEqual([undefined, undefined, undefined]);
    expect([payload.latitude, payload.longitude]).toEqual([36.81, 10.18]);

    const ok = await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), message);

    expect([ok.payload.accuracy, ok.payload.speed, ok.payload.heading]).toEqual([7, 5, 180]);
  });

  it('a position that is not a place is refused before anything is read or written', async () => {
    for (const bad of [{ latitude: 0, longitude: 0 }, { latitude: 95, longitude: 10 }, { latitude: 36, longitude: -200 }, { latitude: NaN, longitude: 10 }, { latitude: 'x', longitude: 10 }]) {
      const w = world('ARTISAN_ON_THE_WAY');
      const { instance } = gateway(w);
      let error: any;

      try {
        await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), { ...message, ...bad } as any);
      } catch (caught) {
        error = caught;
      }

      expect(String(error?.message ?? error)).toMatch(/Invalid GPS coordinates/);
      expect(artisanRow(w).latitude).toBe(null);
      expect(w.artisanLocationPing.rows.length).toBe(0);
    }
  });

  it('the history row is of the job the phone names, not of the latest job the technician has on the route', async () => {
    for (const named of [40, 41]) {
      const w = world('IN_PROGRESS');

      w.intervention.insert({ id: 41, clientId: 10, artisanId: ARTISAN, status: 'ARTISAN_ON_THE_WAY' });

      const { instance } = gateway(w);

      await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), { ...message, interventionId: named });

      expect(`named ${named}: ${w.artisanLocationPing.rows[0].interventionId}`).toBe(`named ${named}: ${named}`);
    }
  });

  it('two positions a second apart: the second moves the dot but adds no row', async () => {
    const w = world('ARTISAN_ON_THE_WAY');
    const { instance } = gateway(w);

    await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), message);
    await instance.updateArtisanLocation(socketOf(ARTISAN, 'ARTISAN'), { ...message, latitude: 36.82 });

    expect(w.artisanLocationPing.rows.length).toBe(1);
    expect(artisanRow(w).latitude).toBe(36.82);
  });
});

describe('the older general route (P3-05)', () => {
  const service = (w: ReturnType<typeof world>) => new UsersService(w.prisma, {} as any, {} as any, {} as any);

  it('a technician: the position, its time and the history, as through the artisan routes', async () => {
    const w = world('ARTISAN_ON_THE_WAY');

    await service(w).updateLocation(ARTISAN, 36.81, 10.18);

    expect(artisanRow(w).positionAt instanceof Date).toBe(true);
    expect(w.artisanProfile.rows[0].lastSeenAt).toEqual(artisanRow(w).positionAt);
    expect(w.artisanLocationPing.rows.length).toBe(1);
    expect(w.artisanLocationPing.rows[0]).toMatchObject({ artisanId: ARTISAN, interventionId: 40, latitude: 36.81 });
  });

  it('somebody who is not a technician: a plain point, no time, no history', async () => {
    const w = world();

    await service(w).updateLocation(91, 36.81, 10.18);

    const admin = w.user.rows.find((row) => row.id === 91)!;

    expect([admin.latitude, admin.longitude]).toEqual([36.81, 10.18]);
    expect(admin.positionAt).toBe(null);
    expect(w.artisanLocationPing.rows.length).toBe(0);
  });

  it('refuses a position that is not a place, for anybody', async () => {
    for (const id of [ARTISAN, 91]) {
      const w = world();
      let refused = false;

      try {
        await service(w).updateLocation(id, 200, 10);
      } catch {
        refused = true;
      }

      expect(`${id}: ${refused}`).toBe(`${id}: true`);
      expect(w.user.rows.find((row) => row.id === id)!.latitude).toBe(null);
    }
  });
});

describe('nothing else writes the position of a user (P3-05)', () => {
  // A new place that writes `latitude` into a user's row would write a position with no time and no history: it has to be listed here, with the reason.
  const WRITERS: Record<string, string> = {
    'modules/artisans/artisans.service.ts': 'the REST route of the technician’s phone (updateLocation); the service zones and the profile have their own coordinates',
    'modules/realtime/realtime.gateway.ts': 'the live socket (updateArtisanLocation)',
    'modules/users/users.service.ts': 'the older general route (updateLocation)',
  };

  it('is done by the three places that use the plan', () => {
    const found = new Set<string>();

    for (const file of listSourceFiles()) {
      const code = stripComments(readSource(file));
      const pattern = /\.user\.(update|updateMany|upsert)\s*\(/g;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(code))) {
        const open = match.index + match[0].length - 1;
        const argument = balanced(code, open);
        const braceAt = argument.indexOf('{');
        const body = braceAt >= 0 ? balanced(argument, braceAt) : argument;

        // The data written: `data` for update and updateMany, `update` and `create` for upsert.
        const data = ['data', 'update', 'create'].map((key) => valueOfKey(body, key)).filter(Boolean);

        // A write whose data is not a literal cannot be read here; it has to be written as a literal or listed.
        if (data.some((entry) => !entry!.literal && !/^\{/.test(entry!.text))) found.add(file);
        else if (data.some((entry) => /\blatitude\b|\blongitude\b/.test(entry!.text))) found.add(file);
      }
    }

    expect([...found].sort()).toEqual(Object.keys(WRITERS).sort());

    for (const file of found) expect(stripComments(readSource(file))).toMatch(/planPing\(/);
  });
});
