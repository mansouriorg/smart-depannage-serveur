import { message } from './message';

/**
 * A job offered to a technician for a few minutes (P3-07). Only the technician is told, so there is no wording for the customer: the customer
 * learns of the technician when one has taken the job. (What the back office is told stays French and is not here.)
 */
export const offer = {
  offered: {
    title: message({ fr: 'Nouvelle mission proposée', ar: 'مهمّة جديدة مقترحة عليك' }),
    // `until` is an hour on the clock of the company ("14:32"): the offer can be taken until then.
    message: message<{ address: string; until: string }>({
      fr: 'Une mission vous est proposée: {address}. Répondez avant {until}.',
      ar: 'اقتُرحت عليك مهمّة: {address}. يمكنك قبولها حتى الساعة {until}.',
      isolate: ['address', 'until'],
    }),
  },
};
