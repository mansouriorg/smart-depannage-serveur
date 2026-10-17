import { minutesOfDay } from '../../../common/availability/weekly-schedule';

/**
 * "08:00" ... "23:59"; a slot may end at "24:00" (midnight). The hours of a weekly slot
 * are written the way the schedule rule reads them: a slot it cannot read would hide
 * the artisan from every time (P1-05).
 */
export const SLOT_START_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SLOT_END_REGEX = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * A slot that ends before it starts ("17:00-08:00") passes both patterns above and
 * can never hold an appointment, so the artisan would look unavailable all day without
 * any message saying why. null when every slot is in order, else a sentence for the artisan.
 */
export function slotOrderProblem(slots: ReadonlyArray<{ dayOfWeek: string; startTime: string; endTime: string }>): string | null {
  for (const slot of slots) {
    const from = minutesOfDay(slot.startTime);
    const to = minutesOfDay(slot.endTime);

    if (from === null || to === null || to <= from) {
      return `Créneau ${slot.dayOfWeek} ${slot.startTime}-${slot.endTime}: l’heure de fin doit être après l’heure de début.`;
    }
  }

  return null;
}
