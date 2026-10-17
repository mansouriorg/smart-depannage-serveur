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
    /** `in(room).socketsLeave(other)`: every socket of the room leaves the other one. */
    in(room: string) {
      return {
        socketsLeave(leaving: string) {
          for (const joined of Object.values(sockets)) {
            if (joined.includes(room)) {
              const at = joined.indexOf(leaving);

              if (at >= 0) joined.splice(at, 1);
            }
          }
        },
      };
    },
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

describe('an artisan who no longer has the job stops receiving what is said about it', () => {
  function withTheJobRoom() {
    const { gateway, received } = setup();
    const room = gateway.interventionRoom(5);
    const sockets: Record<string, string[]> = {
      admin: ['admins', 'admin-dashboard', gateway.userRoom(1), room],
      client: [gateway.clientRoom(10), gateway.userRoom(10), room],
      artisan: [gateway.artisanRoom(20), gateway.userRoom(20), room],
      // The same artisan on a second device.
      tablet: [gateway.artisanRoom(20), gateway.userRoom(20), room],
      next: [gateway.artisanRoom(30), gateway.userRoom(30), room],
    };
    const fake = fakeServer(sockets);

    gateway.server = fake.server;

    return { gateway, received: fake.received, sockets, room };
  }

  it('every socket of that user leaves the room of the job, and only that user', () => {
    const w = withTheJobRoom();

    w.gateway.removeUserFromIntervention(20, 5);

    expect(w.sockets.artisan).not.toContain(w.room);
    expect(w.sockets.tablet).not.toContain(w.room);
    expect(w.sockets.admin).toContain(w.room);
    expect(w.sockets.client).toContain(w.room);
    expect(w.sockets.next).toContain(w.room);
  });

  it('what is sent to the room afterwards does not reach them, and reaches the others once', () => {
    const w = withTheJobRoom();

    w.gateway.removeUserFromIntervention(20, 5);
    w.gateway.emitToIntervention(5, 'intervention.status.changed', {});

    expect(w.received.artisan).toBeUndefined();
    expect(w.received.tablet).toBeUndefined();
    expect(w.received).toEqual({
      admin: ['intervention.status.changed'],
      client: ['intervention.status.changed'],
      next: ['intervention.status.changed'],
    });
  });

  it('their own rooms stay: they still get what is sent to them (the notification of the refusal)', () => {
    const w = withTheJobRoom();

    w.gateway.removeUserFromIntervention(20, 5);
    w.gateway.emitToUser(20, 'notification', {});

    expect(w.received).toEqual({ artisan: ['notification'], tablet: ['notification'] });
  });

  it('another job\'s room is not touched', () => {
    const w = withTheJobRoom();

    w.sockets.artisan.push(w.gateway.interventionRoom(6));
    w.gateway.removeUserFromIntervention(20, 5);

    expect(w.sockets.artisan).toContain(w.gateway.interventionRoom(6));
  });
});
