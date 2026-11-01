import { reminderLeadWording, reminderMessage } from './appointment-reminders';

const FSI = '⁨';
const PDI = '⁩';

const STARTS_AT = new Date('2026-10-19T07:00:00Z');

describe('how long before the visit, in French as it always was (P3-04)', () => {
  it('the default language is French and the wording has not moved', () => {
    expect(reminderLeadWording(1)).toBe('1 minute');
    expect(reminderLeadWording(30)).toBe('30 minutes');
    expect(reminderLeadWording(60)).toBe('1 heure');
    expect(reminderLeadWording(120)).toBe('2 heures');
    expect(reminderLeadWording(90)).toBe('1 heure 30');
    expect(reminderLeadWording(65)).toBe('1 heure 05');
    expect(reminderLeadWording(1440)).toBe('24 heures');
    expect(reminderLeadWording(60, 'fr')).toBe(reminderLeadWording(60));
  });
});

describe('how long before the visit, in Arabic (P3-04)', () => {
  it('minutes use the plural forms of the language', () => {
    expect(reminderLeadWording(1, 'ar')).toBe('دقيقة');
    expect(reminderLeadWording(2, 'ar')).toBe('دقيقتين');
    expect(reminderLeadWording(5, 'ar')).toBe('5 دقائق');
    expect(reminderLeadWording(30, 'ar')).toBe('30 دقيقة');
  });

  it('hours too, and an hour with minutes is said with "و"', () => {
    expect(reminderLeadWording(60, 'ar')).toBe('ساعة');
    expect(reminderLeadWording(120, 'ar')).toBe('ساعتين');
    expect(reminderLeadWording(180, 'ar')).toBe('3 ساعات');
    expect(reminderLeadWording(1440, 'ar')).toBe('24 ساعة');
    expect(reminderLeadWording(90, 'ar')).toBe('ساعة و30 دقيقة');
    expect(reminderLeadWording(125, 'ar')).toBe('ساعتين و5 دقائق');
  });
});

describe('the reminder of a visit (P3-04)', () => {
  it('French: the sentence the technician and the customer always got', () => {
    expect(reminderMessage(120, STARTS_AT, 'Africa/Tunis')).toBe('Votre intervention est prévue dans 2 heures, le 19/10/2026 à 08:00.');
    expect(reminderMessage(120, STARTS_AT, 'Africa/Tunis', undefined, 'fr')).toBe('Votre intervention est prévue dans 2 heures, le 19/10/2026 à 08:00.');
  });

  it('Arabic: the length of time in words, the day and the hour set apart', () => {
    expect(reminderMessage(120, STARTS_AT, 'Africa/Tunis', undefined, 'ar')).toBe(`موعد تدخّلك بعد ساعتين، بتاريخ ${FSI}19/10/2026${PDI} الساعة ${FSI}08:00${PDI}.`);
  });

  it('what is left of the time is said when the reminder comes late, in either language', () => {
    const now = new Date(STARTS_AT.getTime() - 30 * 60_000);

    expect(reminderMessage(120, STARTS_AT, 'Africa/Tunis', now)).toBe('Votre intervention est prévue dans 30 minutes, le 19/10/2026 à 08:00.');
    expect(reminderMessage(120, STARTS_AT, 'Africa/Tunis', now, 'ar')).toContain('بعد 30 دقيقة');
  });
});
