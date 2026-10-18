import { RealtimeGateway } from './realtime.gateway';

/**
 * P1-08: the gateway itself pushes two things: the status change that other modules hand it, and the
 * artisan's position. The id of whoever acted stays with the dashboard; the position goes to the
 * customer and the room of the job only while the artisan is on the way.
 */
function setup(status = 'ARTISAN_ON_THE_WAY') {
  const sent: Array<{ rooms: string[]; event: string; payload: any }> = [];
  const prisma: any = {
    intervention: { findUnique: async () => ({ id: 1, clientId: 10, artisanId: 20, status }) },
    user: { update: async () => ({}) },
    artisanProfile: { updateMany: async () => ({}) },
  };
  const gateway: any = new RealtimeGateway({} as any, prisma);

  gateway.server = {
    to(room: string) {
      const rooms = [room];
      const chain = {
        to(next: string) {
          rooms.push(next);

          return chain;
        },
        emit(event: string, payload: any) {
          sent.push({ rooms: [...rooms], event, payload });
        },
      };

      return chain;
    },
  };

  const artisanSocket: any = { data: { user: { id: 20, role: 'ARTISAN' } } };

  return { gateway, sent, artisanSocket };
}

describe('what the gateway pushes (P1-08)', () => {
  it('a status change: the dashboard knows who acted, the room of the job does not', () => {
    const { gateway, sent } = setup();

    gateway.emitStatusChange({ interventionId: 1, newStatus: 'CANCELLED', actorId: 5 });

    const room = sent.find((emit) => emit.rooms.includes('intervention:1'))!;
    const admins = sent.find((emit) => emit.rooms.includes('admins'))!;

    expect(room.payload).not.toHaveProperty('actorId');
    expect(admins.payload.actorId).toBe(5);
  });

  it('the position of the artisan on the way reaches the room of the job and the dashboard', async () => {
    const { gateway, sent, artisanSocket } = setup('ARTISAN_ON_THE_WAY');

    await gateway.updateArtisanLocation(artisanSocket, { interventionId: 1, latitude: 36.8, longitude: 10.1 });

    expect(sent.map((emit) => emit.rooms[0])).toEqual(['intervention:1', 'admins']);
  });

  it('at any other time it reaches the dashboard only', async () => {
    for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAID', 'CANCELLED']) {
      const { gateway, sent, artisanSocket } = setup(status);

      await gateway.updateArtisanLocation(artisanSocket, { interventionId: 1, latitude: 36.8, longitude: 10.1 });

      expect(sent.map((emit) => emit.rooms[0])).toEqual(['admins']);
    }
  });
});
