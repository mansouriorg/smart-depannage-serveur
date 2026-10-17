import { readFileSync } from 'fs';
import { join } from 'path';

import { SLOT_END_REGEX, SLOT_START_REGEX, slotOrderProblem } from './slot-time';

/** The hours of a weekly slot are written the way the schedule rule reads them (P1-05). */
describe('the hours of a weekly slot', () => {
  it('a start is HH:mm on a 24-hour clock', () => {
    for (const good of ['00:00', '08:00', '17:30', '23:59']) expect(SLOT_START_REGEX.test(good)).toBe(true);
    for (const bad of ['8:00', '08:00:00', '24:00', '25:00', '12:60', '9h', '', 'matin', ' 08:00']) expect(SLOT_START_REGEX.test(bad)).toBe(false);
  });

  it('an end is the same, and may be 24:00 (midnight)', () => {
    for (const good of ['00:30', '17:00', '23:59', '24:00']) expect(SLOT_END_REGEX.test(good)).toBe(true);
    for (const bad of ['24:01', '8:00', '17:00:00', '12:60', '9h', '', '24:00 ']) expect(SLOT_END_REGEX.test(bad)).toBe(false);
  });

  it('and the slot of the artisan\'s own availability route uses them', () => {
    const text = readFileSync(join(__dirname, 'update-availability.dto.ts'), 'utf8');

    expect(/@Matches\(SLOT_START_REGEX[^\n]*\n\s*startTime/.test(text)).toBe(true);
    expect(/@Matches\(SLOT_END_REGEX[^\n]*\n\s*endTime/.test(text)).toBe(true);
  });
});

describe('the order of the hours of a slot', () => {
  const slot = (startTime: string, endTime: string, dayOfWeek = 'MONDAY') => ({ dayOfWeek, startTime, endTime });

  it('a slot that ends after it starts is fine, up to midnight', () => {
    expect(slotOrderProblem([])).toBe(null);
    expect(slotOrderProblem([slot('08:00', '17:00'), slot('00:00', '24:00', 'TUESDAY')])).toBe(null);
    expect(slotOrderProblem([slot('23:00', '24:00')])).toBe(null);
  });

  it('one that ends before it starts, or at the same time, is refused, and the sentence says which', () => {
    for (const bad of [slot('17:00', '08:00'), slot('08:00', '08:00'), slot('24:00', '24:00')]) {
      const problem = slotOrderProblem([slot('08:00', '09:00'), { ...bad, dayOfWeek: 'FRIDAY' }]);

      expect(String(problem).includes('FRIDAY')).toBe(true);
      expect(String(problem).includes(bad.startTime)).toBe(true);
    }
  });

  it('a time that is not a time is refused too (the patterns are the first check, this is the second)', () => {
    expect(slotOrderProblem([slot('8h', '17:00')]) !== null).toBe(true);
    expect(slotOrderProblem([slot('08:00', '')]) !== null).toBe(true);
  });
});
