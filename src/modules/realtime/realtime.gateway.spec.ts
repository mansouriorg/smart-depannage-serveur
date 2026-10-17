import { RealtimeGateway } from './realtime.gateway';

/**
 * A tiny socket.io: sockets sit in rooms, and `to(a).to(b).emit()` reaches the
 * union of the rooms, each socket once. That is how socket.io itself behaves.
 * Two separate `to(x).emit()` calls reach a socket in both rooms twice, which is
 * exactly what these tests are here to catch.
 */
function fakeServer(sockets: Record<string, string[]>) {
  const received: Record<string, string[]> = {};

  const server = {
    to(room: string) {
      const rooms = [room];
      const chain = {
        to(next: string) {
          rooms.push(next);
          return chain;
        },
        emit(event: string) {
          for (const [id, joined] of Object.entries(sockets)) {
            if (joined.some((r) => rooms.includes(r))) {
              (received[id] ??= []).push(event);
            }
          }
        },
      };
      return chain;
    },
  };

  return { server, received };
}

function setup() {
  const gateway: any = new RealtimeGateway({} as any, {} as any);

  const sockets: Record<string, string[]> = {
    admin: ['admins', 'admin-dashboard', gateway.userRoom(1)],
    client: [gateway.clientRoom(10), gateway.userRoom(10)],
    artisan: [gateway.artisanRoom(20), gateway.userRoom(20)],
    stranger: [gateway.userRoom(99)],
  };

  const { server, received } = fakeServer(sockets);
  gateway.server = server;

  return { gateway, received };
}

describe('each live event reaches a socket once', () => {
  it('to the dashboard: an admin who is in both admin rooms gets one event', () => {
    const { gateway, received } = setup();

    gateway.emitToAdmins('x', {});

    expect(received).toEqual({ admin: ['x'] });
  });

  it('to a customer: one event although they are in their client room and their user room', () => {
    const { gateway, received } = setup();

    gateway.emitToClient(10, 'x', {});

    expect(received).toEqual({ client: ['x'] });
  });

  it('to an artisan: one event, and nobody else gets it', () => {
    const { gateway, received } = setup();

    gateway.emitToArtisan(20, 'x', {});

    expect(received).toEqual({ artisan: ['x'] });
  });

  it('to one user: only that user', () => {
    const { gateway, received } = setup();

    gateway.emitToUser(1, 'x', {});

    expect(received).toEqual({ admin: ['x'] });
  });
});
