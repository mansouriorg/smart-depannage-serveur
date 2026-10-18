import { FakeTable } from '../../common/testing/fake-tables';
import { migrateTrades } from './trade-migration';

function makeWorld(rows: Array<Record<string, any>>, options: { editWhileRunning?: number } = {}) {
  const profiles = new FakeTable({
    defaults: () => ({ specialty: null, specialties: [], serviceTypes: [], updatedAt: new Date('2026-10-01T10:00:00Z') }),
  });

  rows.forEach((row) => profiles.insert(row));

  const db: any = {
    artisanProfile: {
      findMany: async () => {
        const read = profiles.rows.map((row) => ({ ...row, specialties: [...row.specialties], serviceTypes: [...row.serviceTypes] }));

        // somebody edits a profile after the script has read it
        if (options.editWhileRunning) {
          const edited = profiles.rows.find((row) => row.id === options.editWhileRunning)!;
          edited.updatedAt = new Date('2026-10-18T09:00:00Z');
        }

        return read;
      },
      updateMany: async ({ where, data }: any) => {
        const row = profiles.rows.find((item) => item.id === where.id && item.updatedAt.getTime() === where.updatedAt.getTime());

        if (!row) return { count: 0 };

        Object.assign(row, data, { updatedAt: new Date('2026-10-18T10:00:00Z') });

        return { count: 1 };
      },
    },
  };

  return { db, profiles };
}

describe('the trades of the profiles made before the table (P1-10)', () => {
  const legacy = () => [
    { specialty: 'Plombier', specialties: ['Plombier'] },
    { specialty: 'Climatisation', specialties: [] },
    { specialty: 'Polyvalent', specialties: ['Polyvalent', 'Électricien'] },
    { specialty: 'Maçon', specialties: ['Maçon'] },
    { specialty: null, specialties: [] },
  ];

  it('a dry run reads everything and writes nothing', async () => {
    const w = makeWorld(legacy());
    const before = JSON.stringify(w.profiles.rows);

    const report = await migrateTrades(w.db, { apply: false });

    expect(report.profiles).toBe(5);
    expect(report.toChange.length).toBe(4);
    expect(report.withoutTrades).toEqual([5]);
    expect(report.unrecognized).toEqual([{ profileId: 4, words: ['Maçon'] }]);
    expect(report.written).toEqual([]);
    expect(JSON.stringify(w.profiles.rows)).toBe(before);
  });

  it('writes the labels and the service types on every profile that has words', async () => {
    const w = makeWorld(legacy());

    const report = await migrateTrades(w.db, { apply: true });

    expect(report.written).toEqual([1, 2, 3, 4]);

    const [plumber, climate, general, mason, nothing] = w.profiles.rows;

    expect(plumber.serviceTypes).toEqual(['PLOMBIER']);
    expect(climate.specialty).toBe('Climaticien');
    expect(climate.serviceTypes).toEqual(['CLIMATICIEN']);
    expect(general.specialties).toEqual(['Autre', 'Électricien']);
    expect(general.serviceTypes).toEqual(['AUTRE', 'ELECTRICIEN']);
    // a word that names no trade stays as written, and the profile counts as "Autre"
    expect(mason.specialty).toBe('Maçon');
    expect(mason.serviceTypes).toEqual(['AUTRE']);
    // nothing to read: left alone
    expect(nothing.serviceTypes).toEqual([]);
  });

  it('every profile with a word ends up with a service type (none is left unmapped)', async () => {
    const w = makeWorld(legacy());

    await migrateTrades(w.db, { apply: true });

    for (const row of w.profiles.rows.filter((item) => item.specialty)) {
      expect(row.serviceTypes.length > 0).toBe(true);
    }
  });

  it('can be run again: the second run changes nothing', async () => {
    const w = makeWorld(legacy());

    await migrateTrades(w.db, { apply: true });
    const after = JSON.stringify(w.profiles.rows);

    const again = await migrateTrades(w.db, { apply: true });

    expect(again.toChange).toEqual([]);
    expect(again.written).toEqual([]);
    expect(JSON.stringify(w.profiles.rows)).toBe(after);
    // the word that names no trade is still listed for the back office
    expect(again.unrecognized).toEqual([{ profileId: 4, words: ['Maçon'] }]);
  });

  it('leaves a profile that was edited while the script ran, and says so', async () => {
    const w = makeWorld(legacy(), { editWhileRunning: 2 });

    const report = await migrateTrades(w.db, { apply: true });

    expect(report.raced).toEqual([2]);
    expect(report.written).toEqual([1, 3, 4]);
    expect(w.profiles.rows[1].serviceTypes).toEqual([]);
  });

  it('the dry run shows, for each profile that changes, what it has now and what it would have', async () => {
    const w = makeWorld(legacy());

    const report = await migrateTrades(w.db, { apply: false });

    expect(report.changes.map((change) => change.profileId)).toEqual([1, 2, 3, 4]);
    expect(report.changes[1].before).toEqual({ specialty: 'Climatisation', specialties: [], serviceTypes: [] });
    expect(report.changes[1].after).toEqual({
      specialty: 'Climaticien',
      specialties: ['Climaticien'],
      serviceTypes: ['CLIMATICIEN'],
    });
  });

  it('the old values are handed over before the first write, and only for the profiles that change', async () => {
    const w = makeWorld(legacy());
    const seen: any[] = [];

    await migrateTrades(w.db, {
      apply: true,
      beforeWrite: (changes) => {
        // nothing is written yet
        seen.push({ ids: changes.map((change) => change.profileId), written: JSON.stringify(w.profiles.rows) });
      },
    });

    expect(seen.length).toBe(1);
    expect(seen[0].ids).toEqual([1, 2, 3, 4]);
    expect(seen[0].written.includes('Climaticien')).toBe(false);
    expect(w.profiles.rows[1].specialty).toBe('Climaticien');
  });

  it('a backup that cannot be saved stops the run before anything is rewritten', async () => {
    const w = makeWorld(legacy());
    const before = JSON.stringify(w.profiles.rows);

    await expect(
      migrateTrades(w.db, {
        apply: true,
        beforeWrite: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');

    expect(JSON.stringify(w.profiles.rows)).toBe(before);
  });

  it('the old values handed over are the stored ones, word for word, service types included', async () => {
    const w = makeWorld([{ specialty: 'plomberie', specialties: ['plomberie', 'Maçon'], serviceTypes: ['SERRURIER'] }]);
    const seen: any[] = [];

    await migrateTrades(w.db, { apply: true, beforeWrite: (changes) => void seen.push(...changes) });

    expect(seen).toEqual([
      {
        profileId: 1,
        before: { specialty: 'plomberie', specialties: ['plomberie', 'Maçon'], serviceTypes: ['SERRURIER'] },
        after: {
          specialty: 'Plombier',
          specialties: ['Plombier', 'Maçon'],
          serviceTypes: ['SERRURIER', 'PLOMBIER', 'AUTRE'],
        },
      },
    ]);
  });

  it('a backup that fails, whether it throws or answers late with a refusal, stops the run', async () => {
    for (const beforeWrite of [
      () => {
        throw new Error('disk full');
      },
      async () => {
        throw new Error('disk full');
      },
    ]) {
      const w = makeWorld(legacy());
      const before = JSON.stringify(w.profiles.rows);

      await expect(migrateTrades(w.db, { apply: true, beforeWrite })).rejects.toThrow('disk full');

      expect(JSON.stringify(w.profiles.rows)).toBe(before);
    }
  });

  it('the dry run does not ask for a backup, and a run with nothing to change does not either', async () => {
    const w = makeWorld(legacy());
    let calls = 0;
    const beforeWrite = () => {
      calls += 1;
    };

    await migrateTrades(w.db, { apply: false, beforeWrite });
    expect(calls).toBe(0);

    await migrateTrades(w.db, { apply: true, beforeWrite });
    expect(calls).toBe(1);

    await migrateTrades(w.db, { apply: true, beforeWrite });
    expect(calls).toBe(1);
  });

  it('a text read only through a keyword is listed apart, so the guess can be checked', async () => {
    const w = makeWorld([
      { specialty: 'Pose de portes et fenêtres', specialties: [] },
      { specialty: 'Plombier', specialties: ['Plombier'] },
      { specialty: 'Cleaning & nettoyage', specialties: [] },
    ]);

    const report = await migrateTrades(w.db, { apply: false });

    expect(report.inferred).toEqual([{ profileId: 1, words: ['Pose de portes et fenêtres'] }]);
    // a short keyword inside another word is not a guess, it is a word that names no trade
    expect(report.unrecognized).toEqual([{ profileId: 3, words: ['Cleaning & nettoyage'] }]);
  });

  it('a profile that has service types but no specialty text is reported apart, not as seeing every job', async () => {
    const w = makeWorld([
      { specialty: null, specialties: [], serviceTypes: ['VITRIER'] },
      { specialty: null, specialties: [], serviceTypes: [] },
    ]);

    const report = await migrateTrades(w.db, { apply: false });

    expect(report.typesOnly).toEqual([1]);
    expect(report.withoutTrades).toEqual([2]);
    expect(report.toChange).toEqual([]);
  });
});
