import * as fs from 'fs';
import * as path from 'path';

import { appointmentForParties, appointmentRequestForParties } from './views';

/**
 * The visit of a job, as the customer and the artisan read it (P1-17). The scheduling routes used to answer with the
 * row: the back office's note, the id of the staff member who planned it, the reminders the server keeps, and the
 * artisan's e-mail to the customer.
 */

/** The scalar columns of a model, read from the schema. */
function schemaColumns(model: string): string[] {
  const schema = fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const enums = new Set([...schema.matchAll(/^enum (\w+) \{/gm)].map((match) => match[1]));
  const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]));
  const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)![1];
  const scalars = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes']);
  const columns: string[] = [];

  for (const line of body.split('\n')) {
    const match = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);

    if (!match || line.trim().startsWith('//') || line.trim().startsWith('@@')) continue;

    const [, name, type] = match;

    if (models.has(type)) continue;

    if (scalars.has(type) || enums.has(type)) columns.push(name);
  }

  return columns.sort();
}

/** A row with every column of the model set to a value that names the column. */
function fullRow(model: string, extra: Record<string, unknown> = {}): Record<string, any> {
  const row: Record<string, unknown> = {};

  for (const column of schemaColumns(model)) row[column] = `SECRET:${model}.${column}`;

  return { ...row, ...extra };
}

const KEPT_INSIDE_APPOINTMENT = ['adminNote', 'artisanNote', 'scheduledById'];
const KEPT_INSIDE_REQUEST_FOR_THE_OTHER_PARTY = ['adminResponse', 'reviewedById'];

describe('the visit as the customer and the artisan read it (P1-17)', () => {
  it('decides, for every column of the Appointment model, whether the parties read it', () => {
    const view = appointmentForParties(fullRow('Appointment'), 'client', 1);
    const shown = Object.keys(view).sort();

    expect([...shown, ...KEPT_INSIDE_APPOINTMENT].sort()).toEqual(schemaColumns('Appointment'));
  });

  it('keeps the back office\'s note and the staff id out, on both sides', () => {
    for (const side of ['client', 'artisan'] as const) {
      const view = appointmentForParties(fullRow('Appointment'), side, 1);

      for (const column of KEPT_INSIDE_APPOINTMENT) expect(view).not.toHaveProperty(column);
      expect(JSON.stringify(view)).not.toContain('Appointment.adminNote');
      expect(JSON.stringify(view)).not.toContain('Appointment.scheduledById');
    }
  });

  it('keeps what both sides wrote and when the visit is', () => {
    const view = appointmentForParties(fullRow('Appointment'), 'artisan', 1);

    expect(view.clientNote).toBe('SECRET:Appointment.clientNote');
    expect(view.startsAt).toBe('SECRET:Appointment.startsAt');
    expect(view.endsAt).toBe('SECRET:Appointment.endsAt');
    expect(view.status).toBe('SECRET:Appointment.status');
    expect(view.cancelReason).toBe('SECRET:Appointment.cancelReason');
  });

  it('shows the customer the artisan as a name and a number, never the address, and no reminder', () => {
    const view = appointmentForParties(
      {
        ...fullRow('Appointment'),
        client: { id: 1, name: 'Sami', email: 'sami@example.test', phone: '20 111 111', role: 'CLIENT' },
        artisan: { id: 2, name: 'Karim', email: 'karim@example.test', phone: '20 222 222', role: 'ARTISAN' },
        reminders: [{ id: 5, error: 'smtp password rejected' }],
      },
      'client',
      1,
    );

    expect(view.artisan).toEqual({ id: 2, name: 'Karim', phone: '20 222 222' });
    expect(view.client).toEqual({ id: 1, name: 'Sami', email: 'sami@example.test', phone: '20 111 111' });
    expect(view).not.toHaveProperty('reminders');
    expect(JSON.stringify(view)).not.toContain('karim@example.test');
    expect(JSON.stringify(view)).not.toContain('smtp password');
  });

  it('shows the artisan the customer as they have it everywhere else, and no reminder', () => {
    const view = appointmentForParties(
      {
        ...fullRow('Appointment'),
        client: { id: 1, name: 'Sami', email: 'sami@example.test', phone: '20 111 111', role: 'CLIENT' },
        artisan: { id: 2, name: 'Karim', email: 'karim@example.test', phone: '20 222 222', role: 'ARTISAN' },
        reminders: [{ id: 5, error: 'smtp password rejected' }],
      },
      'artisan',
      2,
    );

    expect(view.client).toEqual({ id: 1, name: 'Sami', phone: '20 111 111', email: 'sami@example.test' });
    expect(view.artisan).toEqual({ id: 2, name: 'Karim', phone: '20 222 222', email: 'karim@example.test' });
    expect(view).not.toHaveProperty('reminders');
  });

  it('adds nothing that was not asked for, and passes an absent visit', () => {
    const view = appointmentForParties({ id: 3, adminNote: 'x', status: 'REQUESTED' }, 'client', 1);

    expect(view).toEqual({ id: 3, status: 'REQUESTED' });
    expect(appointmentForParties(null, 'client', 1)).toBeNull();
    expect(appointmentForParties(undefined, 'artisan', 1)).toBeUndefined();
  });
});

describe('a request to move or cancel the visit (P1-17)', () => {
  it('decides, for every column of the AppointmentRequest model, who reads it', () => {
    const asker = appointmentRequestForParties(fullRow('AppointmentRequest', { requestedById: 7 }), 7);
    const other = appointmentRequestForParties(fullRow('AppointmentRequest', { requestedById: 7 }), 8);

    // The asker has the answer of the back office; the other party has neither it nor who reviewed.
    expect(asker).toHaveProperty('adminResponse');
    expect(asker).not.toHaveProperty('reviewedById');
    expect(other).not.toHaveProperty('adminResponse');
    expect(other).not.toHaveProperty('reviewedById');
    expect([...Object.keys(other), ...KEPT_INSIDE_REQUEST_FOR_THE_OTHER_PARTY].sort()).toEqual(schemaColumns('AppointmentRequest'));
  });

  it('is part of the visit, with the same rule for each request', () => {
    const view = appointmentForParties(
      {
        ...fullRow('Appointment'),
        requests: [
          { id: 1, requestedById: 1, adminResponse: 'Refusé, le client insiste souvent', reviewedById: 9, reason: 'Imprévu' },
          { id: 2, requestedById: 2, adminResponse: 'Accepté', reviewedById: 9, reason: 'Panne' },
        ],
      },
      'artisan',
      2,
    );

    expect(view.requests).toEqual([
      { id: 1, requestedById: 1, reason: 'Imprévu' },
      { id: 2, requestedById: 2, adminResponse: 'Accepté', reason: 'Panne' },
    ]);
  });
});
