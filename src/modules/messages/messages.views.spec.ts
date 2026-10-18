import { ForbiddenException } from '@nestjs/common';

import { leaked, poisonedJob } from '../../common/testing/poison';
import { chatsOf } from '../../common/views/views';
import { MessagesService } from './messages.service';

/**
 * P1-08: a message as the customer or the artisan reads it has no address of the writer and no id
 * of the other readers; the support reads the row as it is.
 */
function makeWorld() {
  const messages = poisonedJob().messages as any[];
  const withJob = (message: any) => ({ ...message, intervention: { id: 1, clientId: 10, artisanId: 20, status: 'ARTISAN_ASSIGNED' } });
  const asked: Record<string, any> = {};
  const prisma: any = {
    intervention: { findUnique: async () => poisonedJob() },
    message: {
      create: async ({ data }: any) => withJob({ ...messages[0], ...data, id: 9, readByUserIds: [...data.readByUserIds, 4242] }),
      findMany: async (args: any) => {
        asked.findMany = args;

        return messages.filter((message) => args.where.audience.in.includes(message.audience) && !message.deletedAt);
      },
      findUnique: async ({ where }: any) => {
        const found = messages.find((message) => message.id === where.id);

        return found ? withJob(found) : null;
      },
      update: async ({ where, data }: any) => withJob({ ...messages.find((message) => message.id === where.id), ...data }),
    },
  };
  const realtime: any = { emitNewMessage: async () => undefined };
  const notifications: any = { notifyNewMessage: async () => undefined };

  return { service: new MessagesService(prisma, realtime, notifications), asked };
}

const dto = (audience: string) => ({ audience, content: 'Bonjour' }) as any;

describe('the messages a customer or an artisan reads (P1-08)', () => {
  it('a message just sent: no address of the writer, no id of the other readers', async () => {
    const world = makeWorld();

    for (const [id, role, audience] of [
      [10, 'CLIENT', 'CLIENT_ARTISAN'],
      [10, 'CLIENT', 'CLIENT_SUPPORT'],
      [20, 'ARTISAN', 'CLIENT_ARTISAN'],
      [20, 'ARTISAN', 'ARTISAN_SUPPORT'],
    ] as const) {
      const answer: any = await world.service.create(id, role as any, 1, dto(audience));

      expect(leaked(answer)).toEqual([]);
      expect(answer).not.toHaveProperty('readByUserIds');
      expect(answer).not.toHaveProperty('intervention');
      expect(JSON.stringify(answer)).not.toContain('4242');
    }
  });

  it('the conversation: the reader\'s chats only, asked of the database that way, with names and no addresses', async () => {
    const world = makeWorld();
    const client: any[] = await world.service.findByIntervention(10, 'CLIENT' as any, 1);

    expect(world.asked.findMany.where.audience.in).toEqual(chatsOf('client'));
    expect(world.asked.findMany.where.deletedAt).toBeNull();
    expect(client.map((message) => message.id)).toEqual([1, 2]);
    expect(leaked(client)).toEqual([]);

    const artisan: any[] = await world.service.findByIntervention(20, 'ARTISAN' as any, 1);

    expect(world.asked.findMany.where.audience.in).toEqual(chatsOf('artisan'));
    expect(artisan.map((message) => message.id)).toEqual([1, 3]);
    expect(leaked(artisan)).toEqual([]);
  });

  it('one message, marked read, or deleted: the same copy', async () => {
    const world = makeWorld();

    for (const answer of [
      await world.service.findOne(10, 'CLIENT' as any, 1),
      await world.service.markAsRead(10, 'CLIENT' as any, 1),
      await world.service.markAsRead(10, 'CLIENT' as any, 2),
      await world.service.remove(20, 'ARTISAN' as any, 1),
    ] as any[]) {
      expect(leaked(answer)).toEqual([]);
      expect(answer).not.toHaveProperty('readByUserIds');
      expect(answer).not.toHaveProperty('intervention');
    }
  });

  it('the chat between the artisan and the support is not the customer\'s, whoever asks for it by number', async () => {
    const world = makeWorld();

    await expect(world.service.findOne(10, 'CLIENT' as any, 3)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(world.service.markAsRead(10, 'CLIENT' as any, 3)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the support reads the row as it is', async () => {
    const world = makeWorld();
    const answer: any = await world.service.findOne(5, 'SUPPORT' as any, 2);

    expect(answer.readByUserIds).toEqual([]);
    expect(answer.sender.email).toBe('SECRET<sender.email>');
  });
});
