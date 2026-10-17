import { ArtisanVerificationStatus, Role } from '../../../generated/prisma/client';
import {
  DEFAULT_ARTISAN_PAGE_SIZE,
  MAX_ARTISAN_PAGE_SIZE,
  artisanListWhere,
  artisanPageSize,
  isTruthyFlag,
} from './artisan-list-filter';

describe('GET /users/artisans: who the dropdown of the dashboard may offer (P1-05)', () => {
  it('lists every artisan of the app by default, so the technicians page can approve them', () => {
    expect(artisanListWhere({})).toEqual({ role: Role.ARTISAN, deletedAt: null });
  });

  it('assignable=true keeps only active accounts whose application was approved', () => {
    const where = artisanListWhere({ assignable: 'true' });

    expect(where.role).toBe(Role.ARTISAN);
    expect(where.deletedAt).toBe(null);
    expect(where.isActive).toBe(true);
    expect(where.artisanProfile).toEqual({ is: { verificationStatus: ArtisanVerificationStatus.APPROVED } });
  });

  it.each(['true', 'TRUE', ' true ', '1'])('%p switches the filter on', (value) => {
    expect(isTruthyFlag(value)).toBe(true);
    expect(artisanListWhere({ assignable: value }).isActive).toBe(true);
  });

  it.each([undefined, '', 'false', '0', 'yes', 'no', 'null'])('%p leaves it off', (value) => {
    expect(isTruthyFlag(value)).toBe(false);
    expect(artisanListWhere({ assignable: value }).isActive).toBe(undefined);
  });

  it('the search still applies, together with the filter', () => {
    const where = artisanListWhere({ assignable: 'true', search: 'ali' });

    expect(where.isActive).toBe(true);
    expect(Array.isArray(where.OR) && (where.OR as unknown[]).length).toBe(3);
  });

  it('the page size is 50 unless asked, and never more than 200', () => {
    expect(artisanPageSize(undefined)).toBe(DEFAULT_ARTISAN_PAGE_SIZE);
    expect(artisanPageSize('')).toBe(50);
    expect(artisanPageSize('abc')).toBe(50);
    expect(artisanPageSize('0')).toBe(50);
    expect(artisanPageSize('-5')).toBe(50);
    expect(artisanPageSize('10')).toBe(10);
    expect(artisanPageSize('10.9')).toBe(10);
    expect(artisanPageSize('200')).toBe(MAX_ARTISAN_PAGE_SIZE);
    expect(artisanPageSize('100000')).toBe(MAX_ARTISAN_PAGE_SIZE);
    expect(artisanPageSize('Infinity')).toBe(50);
  });
});
