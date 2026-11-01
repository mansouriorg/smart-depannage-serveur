import { message } from './message';

/** The reminder of a visit. `lead` is "2 heures" / "ساعتين", written by the `lead` messages; `when` by `whenIn`. */
export const appointment = {
  reminder: {
    title: message({ fr: 'Rappel de rendez-vous', ar: 'تذكير بالموعد' }),
    message: message<{ lead: string; when: string }>({
      fr: 'Votre intervention est prévue dans {lead}, le {when}.',
      ar: 'موعد تدخّلك بعد {lead}، بتاريخ {when}.',
    }),
  },

  // French: 0 and 1 are singular ("0 minute", "1 heure"), as the reminder always wrote them. Arabic has the six forms.
  lead: {
    minutes: message<{ count: number }>({
      fr: '{count, plural, one{{count} minute} other{{count} minutes}}',
      ar: '{count, plural, one{دقيقة} two{دقيقتين} few{{count} دقائق} many{{count} دقيقة} other{{count} دقيقة}}',
    }),
    hours: message<{ count: number }>({
      fr: '{count, plural, one{{count} heure} other{{count} heures}}',
      ar: '{count, plural, one{ساعة} two{ساعتين} few{{count} ساعات} many{{count} ساعة} other{{count} ساعة}}',
    }),
    // "2 heures 05" / "ساعتين و30 دقيقة": the hours, then the minutes that are left.
    hoursAndMinutes: message<{ hours: string; minutes: string }>({ fr: '{hours} {minutes}', ar: '{hours} و{minutes}' }),
  },
};
