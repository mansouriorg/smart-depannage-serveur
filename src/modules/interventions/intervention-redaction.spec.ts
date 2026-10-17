import { forMarketplace, withoutStaffFields } from './intervention-redaction';

const row = {
  id: 7,
  status: 'PENDING',
  address: '1 rue de Tunis',
  adminInternalNotes: 'client difficile',
  adminReviewStartedAt: new Date(),
  trackingToken: 'hash',
  cancelledById: 3,
  contactName: 'Salah',
  contactPhone: '20123456',
  contactEmail: 's@example.tn',
};

describe('intervention redaction', () => {
  it('withoutStaffFields removes staff data but keeps contact data', () => {
    const out = withoutStaffFields(row);

    expect(out.adminInternalNotes).toBeUndefined();
    expect(out.adminReviewStartedAt).toBeUndefined();
    expect(out.trackingToken).toBeUndefined();
    expect(out.cancelledById).toBeUndefined();
    expect(out.contactPhone).toBe('20123456');
    expect(out.address).toBe('1 rue de Tunis');
  });

  it('forMarketplace also removes every way to reach the client', () => {
    const out = forMarketplace(row);

    expect(out.contactName).toBeUndefined();
    expect(out.contactPhone).toBeUndefined();
    expect(out.contactEmail).toBeUndefined();
    expect(out.adminInternalNotes).toBeUndefined();
    expect(out.id).toBe(7);
    expect(out.status).toBe('PENDING');
  });

  it('does not mutate the original row', () => {
    withoutStaffFields(row);
    forMarketplace(row);

    expect(row.contactPhone).toBe('20123456');
    expect(row.adminInternalNotes).toBe('client difficile');
  });
});
