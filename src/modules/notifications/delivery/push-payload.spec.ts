import { pushPayload } from './push-payload';

describe('pushPayload (P1-15)', () => {
  it('says the kind, the notification and the job, so that a tap opens the right mission', () => {
    expect(
      pushPayload({ id: 41, type: 'ARTISAN_ASSIGNED', entityType: 'INTERVENTION', entityId: 905 }),
    ).toEqual({
      type: 'ARTISAN_ASSIGNED',
      notificationId: 41,
      entityType: 'INTERVENTION',
      entityId: 905,
      interventionId: 905,
    });
  });

  it('keeps what the notification carries, and adds the kind and the job to it', () => {
    expect(
      pushPayload({
        id: 2,
        type: 'NEW_INTERVENTION_CREATED',
        entityType: 'INTERVENTION',
        entityId: 7,
        data: { interventionId: 7, serviceType: 'PLUMBING' },
      }),
    ).toEqual({
      type: 'NEW_INTERVENTION_CREATED',
      notificationId: 2,
      entityType: 'INTERVENTION',
      entityId: 7,
      interventionId: 7,
      serviceType: 'PLUMBING',
    });
  });

  it('a key of the data cannot pretend to be the kind, the notification or the job', () => {
    const payload = pushPayload({
      id: 3,
      type: 'QUOTE_SENT',
      entityType: 'INTERVENTION',
      entityId: 12,
      data: { type: 'ARTISAN_ASSIGNED', notificationId: 999, interventionId: 1, entityId: 1, quoteId: 5 },
    });

    expect(payload.type).toBe('QUOTE_SENT');
    expect(payload.notificationId).toBe(3);
    expect(payload.interventionId).toBe(12);
    expect(payload.entityId).toBe(12);
    expect(payload.quoteId).toBe(5);
  });

  it('a notification that is not about a job names no job', () => {
    const payload = pushPayload({ id: 4, type: 'PAYMENT_RECEIVED', entityType: 'PAYMENT', entityId: 30 });

    expect(payload.interventionId).toBe(undefined);
    expect(payload.entityType).toBe('PAYMENT');
    expect(payload.entityId).toBe(30);
  });

  it('a notification about nothing in particular still says what it is', () => {
    expect(pushPayload({ id: 5, type: 'SYSTEM', entityType: null, entityId: null, data: null })).toEqual({
      type: 'SYSTEM',
      notificationId: 5,
    });
  });

  it('data that is not an object (a list, a text) is left out', () => {
    expect(pushPayload({ id: 6, type: 'SYSTEM', data: ['a', 'b'] })).toEqual({ type: 'SYSTEM', notificationId: 6 });
    expect(pushPayload({ id: 7, type: 'SYSTEM', data: 'text' })).toEqual({ type: 'SYSTEM', notificationId: 7 });
  });
});
