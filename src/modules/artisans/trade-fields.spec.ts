import { BadRequestException } from '@nestjs/common';

import { approvedProfileData } from './approved-profile';
import { lenientTradeFields, profileMigration, tradeFieldsFor, tradeFieldsForEdit, tradesOfProfile } from './trade-fields';

function refusal(run: () => unknown): any {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the trades written on an artisan profile (P1-10)', () => {
  describe('what a person or the back office sends (strict)', () => {
    it('writes the three fields together from one trade', () => {
      expect(tradeFieldsFor({ specialty: 'plombier' })).toEqual({
        specialty: 'Plombier',
        specialties: ['Plombier'],
        serviceTypes: ['PLOMBIER'],
      });
    });

    it('writes every trade of a list, the main one first, without doubles', () => {
      expect(tradeFieldsFor({ specialty: 'Climatisation', specialties: ['Électricité', 'climatisation', 'Vitrier'] })).toEqual({
        specialty: 'Climaticien',
        specialties: ['Climaticien', 'Électricien', 'Vitrier'],
        serviceTypes: ['CLIMATICIEN', 'ELECTRICIEN', 'VITRIER'],
      });
    });

    it('takes the first of the list as the main trade when only a list is sent', () => {
      expect(tradeFieldsFor({ specialties: ['Serrurerie', 'Menuiserie'] })).toEqual({
        specialty: 'Serrurier',
        specialties: ['Serrurier', 'Menuisier'],
        serviceTypes: ['SERRURIER', 'MENUISIER'],
      });
    });

    it('stores the words the way the table writes them, wherever they come from', () => {
      expect(tradeFieldsFor({ specialties: ['PLOMBERIE', '  électricité '] })!.specialties).toEqual(['Plombier', 'Électricien']);
      expect(tradeFieldsFor({ specialty: 'Polyvalent' })!.serviceTypes).toEqual(['AUTRE']);
    });

    it('reads a text that points to two trades as both', () => {
      expect(tradeFieldsFor({ specialty: 'Plombier chauffagiste' })).toEqual({
        specialty: 'Plombier',
        specialties: ['Plombier', 'Chauffagiste'],
        serviceTypes: ['PLOMBIER', 'CHAUFFAGISTE'],
      });
    });

    it('does nothing when no trade was sent: the columns stay as they are', () => {
      expect(tradeFieldsFor({})).toBe(null);
      expect(tradeFieldsFor({ specialty: undefined, specialties: undefined })).toBe(null);
    });

    it('refuses a word that is no trade, names it, and lists the trades to choose from (400)', () => {
      const error = refusal(() => tradeFieldsFor({ specialty: 'Plombier', specialties: ['Sorcier', 'Maçon'] }));

      expect(error instanceof BadRequestException).toBe(true);
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('« Sorcier »');
      expect(error.message).toContain('« Maçon »');
      expect(error.message).toContain('Chauffagiste');
      expect(error.message).toContain('Climaticien');
    });

    it('refuses an empty list: an artisan cannot empty it to see every job', () => {
      for (const input of [{ specialties: [] }, { specialty: '' }, { specialty: '   ', specialties: [''] }, { specialty: null, specialties: null }]) {
        const error = refusal(() => tradeFieldsFor(input as any));

        expect(error.getStatus()).toBe(400);
        expect(error.message).toMatch(/au moins un métier/);
      }
    });
  });

  describe('what is already written and cannot be asked again (lenient)', () => {
    it('reads the trades as the strict version does', () => {
      expect(lenientTradeFields({ specialty: 'Chauffagiste' })).toEqual({
        specialty: 'Chauffagiste',
        specialties: ['Chauffagiste'],
        serviceTypes: ['CHAUFFAGISTE'],
      });
    });

    it('keeps a word that names no trade as written and counts it as "Autre"', () => {
      expect(lenientTradeFields({ specialty: 'Maçon' })).toEqual({
        specialty: 'Maçon',
        specialties: ['Maçon'],
        serviceTypes: ['AUTRE'],
      });
      expect(lenientTradeFields({ specialty: 'Plombier', specialties: ['Maçon'] })).toEqual({
        specialty: 'Plombier',
        specialties: ['Plombier', 'Maçon'],
        serviceTypes: ['PLOMBIER', 'AUTRE'],
      });
    });

    it('is null when there is nothing to read', () => {
      expect(lenientTradeFields({})).toBe(null);
      expect(lenientTradeFields({ specialty: null, specialties: [] })).toBe(null);
      expect(lenientTradeFields({ specialty: '  ' })).toBe(null);
    });

    it('is what an approved profile is made with: the trades go in with the rest', () => {
      const data = approvedProfileData({ userId: 7, specialty: 'Vitrerie' });

      expect(data.specialty).toBe('Vitrier');
      expect(data.specialties).toEqual(['Vitrier']);
      expect(data.serviceTypes).toEqual(['VITRIER']);
      expect(data.verificationStatus).toBe('APPROVED');
      expect(data.isAcceptingJobs).toBe(true);
    });

    it('leaves the trades out of an approved profile made with none (the columns keep their defaults)', () => {
      const data = approvedProfileData({ userId: 7 });

      expect(data.specialty).toBe(undefined);
      expect(data.specialties).toBe(undefined);
      expect(data.serviceTypes).toBe(undefined);
    });
  });

  describe('the trades an artisan sees jobs of', () => {
    it('are the ones written on the profile and the ones its words point to', () => {
      expect(tradesOfProfile({ serviceTypes: ['PLOMBIER'], specialty: null, specialties: [] })).toEqual(['PLOMBIER']);
      expect(tradesOfProfile({ serviceTypes: [], specialty: 'Plombier', specialties: ['Plombier', 'Climatisation'] })).toEqual([
        'PLOMBIER',
        'CLIMATICIEN',
      ]);
      expect(tradesOfProfile({ serviceTypes: ['VITRIER'], specialty: 'Plombier', specialties: [] })).toEqual(['VITRIER', 'PLOMBIER']);
    });

    it('are "Autre" when the profile has words and none names a trade', () => {
      expect(tradesOfProfile({ serviceTypes: [], specialty: 'Maçon', specialties: ['Maçon'] })).toEqual(['AUTRE']);
    });

    it('are null (every job, as before) when the profile names nothing at all', () => {
      expect(tradesOfProfile({ serviceTypes: [], specialty: null, specialties: [] })).toBe(null);
      expect(tradesOfProfile({})).toBe(null);
    });
  });

  describe('what is written when a profile that has trades is edited', () => {
    const stored = { specialties: ['Plombier', 'Électricien', 'Maçon'], serviceTypes: ['PLOMBIER', 'ELECTRICIEN', 'AUTRE'] };

    it('null when neither the main trade nor the list is sent', () => {
      expect(tradeFieldsForEdit({}, stored)).toBe(null);
    });

    it('the main trade alone goes first and the other trades stay, the stored words as they were written', () => {
      const fields = tradeFieldsForEdit({ specialty: 'Climatisation' }, stored)!;

      expect(fields.specialty).toBe('Climaticien');
      expect(fields.specialties).toEqual(['Climaticien', 'Plombier', 'Électricien', 'Maçon']);
      expect([...fields.serviceTypes].sort()).toEqual(['AUTRE', 'CLIMATICIEN', 'ELECTRICIEN', 'PLOMBIER']);
    });

    it('a service type written by hand with no word to match stays', () => {
      const fields = tradeFieldsForEdit(
        { specialty: 'Plombier' },
        { specialties: ['Plombier'], serviceTypes: ['PLOMBIER', 'VITRIER'] },
      )!;

      expect(fields.serviceTypes).toEqual(['PLOMBIER', 'VITRIER']);
    });

    it('a trade already on the list is not doubled and becomes the main one', () => {
      const fields = tradeFieldsForEdit({ specialty: 'electricien' }, stored)!;

      expect(fields.specialties).toEqual(['Électricien', 'Plombier', 'Maçon']);
    });

    it('a list that is sent replaces the stored one', () => {
      expect(tradeFieldsForEdit({ specialties: ['Vitrier'] }, stored)).toEqual({
        specialty: 'Vitrier',
        specialties: ['Vitrier'],
        serviceTypes: ['VITRIER'],
      });
    });

    it('a profile with no stored trades gets just what was sent; a word that is no trade is still refused', () => {
      expect(tradeFieldsForEdit({ specialty: 'Plombier' }, { specialties: null, serviceTypes: null })).toEqual({
        specialty: 'Plombier',
        specialties: ['Plombier'],
        serviceTypes: ['PLOMBIER'],
      });
      expect(refusal(() => tradeFieldsForEdit({ specialty: 'Sorcier' }, stored)).getStatus()).toBe(400);
    });
  });

  describe('the migration of a stored profile', () => {
    it('writes the labels and the service types a profile with only words should have', () => {
      const plan = profileMigration({ specialty: 'plomberie', specialties: ['Plomberie', 'climatisation'], serviceTypes: [] })!;

      expect(plan.changed).toBe(true);
      expect(plan.fields).toEqual({
        specialty: 'Plombier',
        specialties: ['Plombier', 'Climaticien'],
        serviceTypes: ['PLOMBIER', 'CLIMATICIEN'],
      });
      expect(plan.unrecognized).toEqual([]);
    });

    it('changes nothing the second time', () => {
      const first = profileMigration({ specialty: 'Polyvalent', specialties: [], serviceTypes: [] })!;
      const second = profileMigration({ specialty: first.fields.specialty, specialties: first.fields.specialties, serviceTypes: first.fields.serviceTypes })!;

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.fields).toEqual(first.fields);
    });

    it('keeps the service types already written and adds the new ones', () => {
      const plan = profileMigration({ specialty: 'Plombier', specialties: ['Plombier'], serviceTypes: ['SERRURIER'] })!;

      expect(plan.fields.serviceTypes).toEqual(['SERRURIER', 'PLOMBIER']);
      expect(plan.changed).toBe(true);
    });

    it('lists the words that name no trade, on every run, even when nothing changes', () => {
      const stored = { specialty: 'Maçon', specialties: ['Maçon'], serviceTypes: ['AUTRE'] };
      const plan = profileMigration(stored)!;

      expect(plan.changed).toBe(false);
      expect(plan.unrecognized).toEqual(['Maçon']);
    });

    it('has nothing to do with a profile that has no word at all', () => {
      expect(profileMigration({ specialty: null, specialties: [], serviceTypes: [] })).toBe(null);
    });
  });
});
