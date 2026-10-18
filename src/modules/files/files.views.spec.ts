import { leaked, poisonedFile, secret } from '../../common/testing/poison';
import { FilesService } from './files.service';

/**
 * P1-08: what the routes of the files answer to the customer and to the artisan: what the file is
 * and where to fetch it, not where the server keeps it, nor who replaced it, nor the uploader's
 * address. A secret is planted in each of those columns; a leak names itself.
 */
function makeWorld(file: Record<string, unknown> = {}) {
  const prisma: any = {
    fileAsset: {
      findUnique: async () => poisonedFile(file),
      findMany: async () => [poisonedFile(file), poisonedFile({ ...file, id: 2 })],
      update: async ({ data }: any) => poisonedFile({ ...file, ...data }),
      create: async ({ data }: any) => poisonedFile({ ...data, id: 9 }),
    },
    intervention: { findUnique: async () => ({ id: 1, clientId: 10, artisanId: 20 }) },
  };

  return new FilesService(prisma, { create: async () => undefined } as any);
}

const customer = { id: 10, role: 'CLIENT' as any };
const artisan = { id: 20, role: 'ARTISAN' as any };

describe('the files a customer or an artisan reads (P1-08)', () => {
  it('one file and the files of a job: what it is and where to fetch it', async () => {
    const service = makeWorld();

    for (const user of [customer, artisan]) {
      const one: any = await service.findOne(user, 1);
      const many: any[] = await service.findByEntity(user, 'INTERVENTION', 1);

      for (const file of [one, ...many]) {
        expect(leaked(file)).toEqual([]);
        expect(file).not.toHaveProperty('relativePath');
        expect(file).not.toHaveProperty('checksum');
        expect(file).not.toHaveProperty('storageProvider');
        expect(file).not.toHaveProperty('replacedById');
        expect(file).not.toHaveProperty('uploadedById');
        expect(file.originalName).toBe('fuite.jpg');
        expect(file.mimeType).toBe('image/jpeg');
        expect(file.uploadedBy).toEqual({ name: 'Sam', role: 'SUPPORT' });
      }
    }
  });

  it('deleting a file they put there: the same copy', async () => {
    // (a real path that does not exist on disk: the service ignores a file that is already gone)
    const service = makeWorld({ relativePath: 'uploads/gone.jpg' });
    const answer: any = await service.deleteFile({ id: 5, role: 'CLIENT' as any }, 1);

    expect(leaked(answer)).toEqual([]);
    expect(answer).not.toHaveProperty('relativePath');
    expect(answer).not.toHaveProperty('isDeleted');
    expect(answer.id).toBe(1);
  });

  it('the back office reads the row as it is', async () => {
    const service = makeWorld();
    const answer: any = await service.findOne({ id: 6, role: 'SUPPORT' as any }, 1);

    expect(answer.relativePath).toBe(secret('file.relativePath'));
    expect(answer.uploadedBy.email).toBe(secret('file.uploadedBy.email'));
  });
});
