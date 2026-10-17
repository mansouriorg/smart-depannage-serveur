import { Role } from '../../../generated/prisma/client';
import { canManage, isBackOffice, isTicketStaff } from './role-policy';

describe('canManage (P0-08)', () => {
  it('lets SUPER_ADMIN manage every role, including SUPER_ADMIN', () => {
    for (const target of Object.values(Role)) {
      expect(canManage(Role.SUPER_ADMIN, target as Role)).toBe(true);
      expect(canManage(Role.SUPER_ADMIN, Role.CLIENT, target as Role)).toBe(true);
    }
  });

  it('stops an ADMIN from touching a SUPER_ADMIN', () => {
    expect(canManage(Role.ADMIN, Role.SUPER_ADMIN)).toBe(false);
  });

  it('stops an ADMIN from touching another ADMIN', () => {
    expect(canManage(Role.ADMIN, Role.ADMIN)).toBe(false);
  });

  it('stops an ADMIN from handing out ADMIN or SUPER_ADMIN', () => {
    expect(canManage(Role.ADMIN, Role.CLIENT, Role.ADMIN)).toBe(false);
    expect(canManage(Role.ADMIN, Role.SUPPORT, Role.SUPER_ADMIN)).toBe(false);
  });

  it('lets an ADMIN manage staff below them and outside accounts', () => {
    for (const target of [
      Role.CLIENT,
      Role.ARTISAN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ]) {
      expect(canManage(Role.ADMIN, target)).toBe(true);
    }

    expect(canManage(Role.ADMIN, Role.CLIENT, Role.DISPATCHER)).toBe(true);
  });

  it('never lets a role manage a peer or someone above it', () => {
    for (const actor of [Role.SUPPORT, Role.DISPATCHER, Role.ACCOUNTANT]) {
      for (const target of [
        Role.SUPPORT,
        Role.DISPATCHER,
        Role.ACCOUNTANT,
        Role.ADMIN,
        Role.SUPER_ADMIN,
      ]) {
        expect(canManage(actor, target)).toBe(false);
      }
    }
  });

  it('gives outside accounts (client, artisan) no management power', () => {
    for (const actor of [Role.CLIENT, Role.ARTISAN]) {
      for (const target of Object.values(Role)) {
        expect(canManage(actor, target as Role)).toBe(false);
      }
    }
  });
});

describe('role groups', () => {
  it('ticket staff excludes the accountant, back office includes it', () => {
    expect(isTicketStaff(Role.DISPATCHER)).toBe(true);
    expect(isTicketStaff(Role.ACCOUNTANT)).toBe(false);
    expect(isBackOffice(Role.ACCOUNTANT)).toBe(true);
    expect(isBackOffice(Role.CLIENT)).toBe(false);
    expect(isTicketStaff(undefined)).toBe(false);
  });
});
