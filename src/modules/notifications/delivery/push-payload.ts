/**
 * What travels with a push to the phone (P1-15).
 *
 * The app reads it when the artisan taps the push: `type` says what happened and `interventionId`
 * says which job to open. Until now the push carried only the `data` of the notification, which
 * the assignment did not have, so the tap could open nothing.
 *
 * The keys below are written last, so that a key of the notification's own `data` can never
 * pretend to be another kind of notification (`type`, `notificationId`), or another job when the
 * notification is about a job (`entityType`, `entityId`, `interventionId`). Everything stays small
 * (a push is limited to 4 KB) and holds no text of the job: the app fetches the job itself.
 */
export type PushPayload = Record<string, unknown> & {
  type: string;
  notificationId: number;
  entityType?: string;
  entityId?: number;
  interventionId?: number;
};

type PushSource = {
  id: number;
  type: string;
  entityType?: string | null;
  entityId?: number | null;
  data?: unknown;
};

export function pushPayload(notification: PushSource): PushPayload {
  const own =
    notification.data && typeof notification.data === 'object' && !Array.isArray(notification.data)
      ? (notification.data as Record<string, unknown>)
      : {};

  const payload: PushPayload = {
    ...own,
    type: String(notification.type),
    notificationId: notification.id,
  };

  if (notification.entityType) {
    payload.entityType = notification.entityType;
  }

  if (typeof notification.entityId === 'number') {
    payload.entityId = notification.entityId;
  }

  if (notification.entityType === 'INTERVENTION' && typeof notification.entityId === 'number') {
    payload.interventionId = notification.entityId;
  }

  return payload;
}
