import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';
import { ownPreferences } from './accounts';

/** A notification belongs to the person it was sent to; only the two administrators may look at the others (audit). */
const kinds = [
  { who: 'client' as const, notification: 'clientNotification', token: 'clientPushToken' },
  { who: 'artisan' as const, notification: 'artisanNotification', token: 'artisanPushToken' },
];

const tokenOf = (h: Household, w: World, key: string) => (w.memory.rows('pushDeviceToken').find((row) => row.id === w.ids[h][key]) as any).token as string;

export const notificationScenarios: Scenario[] = kinds.flatMap(({ who, notification, token }): Scenario[] => [
  {
    route: 'GET /notifications/:',
    note: `the notification of the ${who}: the person it was sent to, and the administrators`,
    allowed: [who, 'admins'],
    reads: true,
    request: (h, w) => ({ params: { notificationId: w.ids[h][notification] } }),
  },
  {
    route: 'PATCH /notifications/:/read',
    note: `the notification of the ${who} is marked as read by the person it was sent to`,
    allowed: [who],
    reads: true,
    request: (h, w) => ({ params: { notificationId: w.ids[h][notification] } }),
  },
  {
    route: 'DELETE /notifications/:',
    note: `the notification of the ${who} is deleted by the person it was sent to`,
    allowed: [who],
    request: (h, w) => ({ params: { notificationId: w.ids[h][notification] } }),
  },
  {
    route: 'DELETE /notifications/push-tokens/:',
    note: `the device of the ${who}: somebody else who asks to switch it off is answered, and nothing is switched off`,
    allowed: [who],
    emptyIsFine: true,
    request: (h, w) => ({ params: { token: tokenOf(h, w, token) } }),
  },
]);

export const notificationSelfScenarios: SelfScenario[] = [
  { route: 'GET /notifications/mine', reads: true, request: () => ({}) },
  {
    route: 'GET /notifications/unread/count',
    note: 'a number: household B has two more unread notifications than A, so a count of somebody else\'s shows',
    request: () => ({}),
    prepare: (w) => {
      for (const who of ['client', 'artisan'] as const) {
        for (let n = 0; n < 2; n++) w.fill('notification', { recipientId: w.ids.B[who], type: 'QUOTE_SENT', title: mark('B', `${who} extra notification ${n}`), message: mark('B', `${who} extra text ${n}`) });
      }
    },
    answer: (person, value) => (person.household === null ? null : (value as { count?: number })?.count === (person.household === 'A' ? 1 : 3) ? null : `was told a number of unread notifications that is not theirs: ${JSON.stringify(value)}`),
  },
  { route: 'GET /notifications/unread', reads: true, request: () => ({}) },
  {
    route: 'GET /notifications/read',
    prepare: (w) => w.set('notification', { isRead: true, readAt: new Date('2026-01-01T00:00:00Z') }),
    reads: true,
    request: () => ({}),
  },
  { route: 'GET /notifications/preferences/me', request: () => ({}), answer: ownPreferences },
  { route: 'PATCH /notifications/preferences/me', request: () => ({ body: { emailEnabled: false } }) },
  { route: 'POST /notifications/push-tokens', request: (person) => ({ body: { token: `device-of-${person.key}`, platform: 'android' } }) },
  { route: 'PATCH /notifications/read-all', request: () => ({}) },
];

void mark;
