import { attempt, changedRows } from './access-matrix';
import { SCENARIOS } from './access/all';
import { buildWorld, HOUSEHOLDS, marksOf } from './world';

/**
 * A thing that was deleted is gone for everybody (P1-17): its owner, the other household and the back office. The
 * message, the internal note, the notification and the file are marked as deleted in the database, and each route that
 * reaches one of them by its number must answer that it is not there, say nothing of what it held, and change nothing.
 */
const DELETED: Array<{ what: string; table: string; field: string; value: unknown; routes: string[] }> = [
  { what: 'a message', table: 'message', field: 'deletedAt', value: new Date(), routes: ['GET /messages/:', 'PATCH /messages/:/read', 'DELETE /messages/:'] },
  { what: 'an internal note', table: 'adminInternalNote', field: 'deletedAt', value: new Date(), routes: ['DELETE /messages/admin-notes/:'] },
  { what: 'a notification', table: 'notification', field: 'deletedAt', value: new Date(), routes: ['GET /notifications/:', 'PATCH /notifications/:/read', 'DELETE /notifications/:'] },
  { what: 'a file', table: 'fileAsset', field: 'isDeleted', value: true, routes: ['GET /files/:', 'GET /files/:/download', 'DELETE /files/:', 'PATCH /files/:/replace'] },
];

describe('what was deleted is gone, for its owner too (P1-17)', () => {
  for (const kind of DELETED) {
    for (const route of kind.routes) {
      const scenarios = SCENARIOS.filter((scenario) => scenario.route === route);

      it(`${route}: ${kind.what} that was deleted is not found by anybody`, async () => {
        expect(scenarios.length).toBeGreaterThan(0);

        for (const scenario of scenarios) {
          const w = buildWorld();

          scenario.prepare?.(w);

          for (const row of w.memory.rows(kind.table)) row[kind.field] = kind.value;

          const base = w.memory.snapshot();
          const wrong: string[] = [];

          for (const household of HOUSEHOLDS) {
            const request = await scenario.request(household, w);

            for (const person of Object.values(w.people)) {
              w.memory.restore(base);

              const outcome = await attempt(w, person, route, request);

              if (outcome.ok) wrong.push(`${person.key} on household ${household} was served`);
              else if (![403, 404].includes(outcome.status ?? 0)) wrong.push(`${person.key} on household ${household} got ${outcome.status}`);
              else if (HOUSEHOLDS.some((h) => marksOf(outcome.error, h).length > 0)) wrong.push(`${person.key}: the refusal holds a text of a household`);

              const changed = changedRows(base, w.memory.snapshot());

              if (changed.length > 0) wrong.push(`${person.key} changed ${[...new Set(changed.map((change) => change.table))].join(', ')}`);
            }
          }

          expect(wrong).toEqual([]);
        }
      });
    }
  }

  it('the control: the same calls are served when nothing is deleted', async () => {
    const scenario = SCENARIOS.find((entry) => entry.route === 'GET /notifications/:')!;
    const w = buildWorld();
    const served: string[] = [];

    for (const person of Object.values(w.people)) {
      const outcome = await attempt(w, person, scenario.route, await scenario.request('A', w));

      if (outcome.ok) served.push(person.key);
    }

    expect(served).toContain('clientA');
  });
});
