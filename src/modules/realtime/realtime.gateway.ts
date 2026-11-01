import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';

import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

import { PrismaService } from '../../prisma/prisma.service';
import { getJwtAccessSecret, socketCorsOptions } from '../../config/env';
import { artisanPositionIsShared } from '../../common/views/views';
import { coordinateOf, optionalNumber, validPoint } from '../../common/geo/location-rules';
import { planPing } from '../locations/ping-plan';
import { decimalsToNumbers } from '../../common/money/money-numbers';

import {
  ArtisanLocationUpdateDto,
  JoinInterventionRoomDto,
  LeaveInterventionRoomDto,
} from './dto/realtime.dto';

import {
  Role,
  Status,
} from '../../../generated/prisma/client';
import { isTicketStaff } from '../../common/auth/role-policy';
import { Permission, can } from '../../common/auth/permissions';

type SocketUser = {
  id: number;
  role: Role;
  email?: string;
};

type JwtPayload = {
  sub?: number;
  userId?: number;
  id?: number;
  email?: string;
  role?: Role;
  tokenType?: string;
};

@WebSocketGateway({
  namespace: 'realtime',
  cors: socketCorsOptions,
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private getToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token;

    if (authToken) {
      return String(authToken).replace('Bearer ', '');
    }

    const header = client.handshake.headers.authorization;

    if (!header) {
      return undefined;
    }

    return String(header).replace('Bearer ', '');
  }

  private isAdminRole(role: Role): boolean {
    return can(role, Permission.BACK_OFFICE_ACCESS);
  }

  private getUser(client: Socket): SocketUser {
    const user = client.data.user as SocketUser | undefined;

    if (!user?.id || !user?.role) {
      throw new WsException('Unauthorized socket.');
    }

    return user;
  }

  private interventionRoom(interventionId: number): string {
    return `intervention:${interventionId}`;
  }

  private userRoom(userId: number): string {
    return `user:${userId}`;
  }

  private artisanRoom(artisanId: number): string {
    return `artisan:${artisanId}`;
  }

  private clientRoom(clientId: number): string {
    return `client:${clientId}`;
  }

  private async resolveUserFromToken(token: string): Promise<SocketUser> {
    const payload = this.jwtService.verify<JwtPayload>(token, {
      secret: getJwtAccessSecret(),
    });

    const userId = Number(payload.sub || payload.userId || payload.id);

    if (!userId) {
      throw new WsException('Invalid token payload.');
    }

    const dbUser = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
      },
    });

    if (!dbUser || !dbUser.isActive) {
      throw new WsException('User inactive or not found.');
    }

    return {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
    };
  }

  private async checkInterventionAccess(
    user: SocketUser,
    interventionId: number,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      select: {
        id: true,
        clientId: true,
        artisanId: true,
        status: true,
      },
    });

    if (!intervention) {
      throw new WsException('Intervention introuvable.');
    }

    const isAdmin = this.isAdminRole(user.role);
    const isClient = intervention.clientId === user.id;
    const isArtisan = intervention.artisanId === user.id;

    if (!isAdmin && !isClient && !isArtisan) {
      throw new WsException('Accès refusé à cette intervention.');
    }

    return intervention;
  }

  // ==========================================================
  // Connection lifecycle
  // ==========================================================

  async handleConnection(client: Socket) {
    try {
      const token = this.getToken(client);

      if (!token) {
        client.disconnect();
        return;
      }

      const user = await this.resolveUserFromToken(token);

      client.data.user = user;

      client.join(this.userRoom(user.id));
      client.join(`role:${user.role}`);

      if (user.role === Role.CLIENT) {
        client.join(this.clientRoom(user.id));
      }

      if (user.role === Role.ARTISAN) {
        client.join(this.artisanRoom(user.id));
      }

      if (this.isAdminRole(user.role)) {
        client.join('admins');
        client.join('admin-dashboard');
      }

      client.emit('realtime.connected', {
        socketId: client.id,
        userId: user.id,
        role: user.role,
      });
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    return {
      disconnected: client.id,
    };
  }

  // ==========================================================
  // Client events
  // ==========================================================

  @SubscribeMessage('ping')
  ping(@ConnectedSocket() client: Socket) {
    const user = this.getUser(client);

    return {
      event: 'pong',
      data: {
        userId: user.id,
        at: new Date(),
      },
    };
  }

  /**
   * Client/admin/artisan joins one intervention tracking room.
   *
   * socket.emit('intervention.join', { interventionId: 12 })
   */
  @SubscribeMessage('intervention.join')
  async joinIntervention(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinInterventionRoomDto,
  ) {
    const user = this.getUser(client);
    const interventionId = Number(body.interventionId);

    const intervention = await this.checkInterventionAccess(
      user,
      interventionId,
    );

    await client.join(this.interventionRoom(interventionId));

    client.emit('intervention.joined', {
      interventionId,
      status: intervention.status,
    });

    return {
      success: true,
      interventionId,
      room: this.interventionRoom(interventionId),
    };
  }

  /**
   * Leave intervention tracking room.
   *
   * socket.emit('intervention.leave', { interventionId: 12 })
   */
  @SubscribeMessage('intervention.leave')
  async leaveIntervention(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: LeaveInterventionRoomDto,
  ) {
    const interventionId = Number(body.interventionId);

    await client.leave(this.interventionRoom(interventionId));

    client.emit('intervention.left', {
      interventionId,
    });

    return {
      success: true,
      interventionId,
    };
  }

  /**
   * Admin dashboard explicit join.
   *
   * socket.emit('admin.dashboard.join')
   */
  @SubscribeMessage('admin.dashboard.join')
  async joinAdminDashboard(@ConnectedSocket() client: Socket) {
    const user = this.getUser(client);

    if (!this.isAdminRole(user.role)) {
      throw new WsException('Admin access required.');
    }

    await client.join('admin-dashboard');

    client.emit('admin.dashboard.joined', {
      success: true,
    });

    return {
      success: true,
      room: 'admin-dashboard',
    };
  }

  /**
   * Artisan sends live location.
   *
   * socket.emit('artisan.location.update', {
   *   interventionId: 12,
   *   latitude: 48.8566,
   *   longitude: 2.3522,
   *   accuracy: 12,
   *   heading: 90,
   *   speed: 15
   * })
   */
  @SubscribeMessage('artisan.location.update')
  async updateArtisanLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ArtisanLocationUpdateDto,
  ) {
    const user = this.getUser(client);

    // The position of an artisan is theirs to send, or the staff's who work on tickets: the accountant writes no position.
    if (user.role !== Role.ARTISAN && !isTicketStaff(user.role)) {
      throw new WsException('Only artisan or admin can update location.');
    }

    const interventionId = Number(body.interventionId);

    // Finite, on the earth and not the 0,0 of a phone with no reading (P3-05): checked here so that nothing is read or written for it.
    // A null, an empty text or a list is not a number: `Number(null)` is 0, and a half reading (a phone's NaN travels as null) must not become a place.
    const point = validPoint(coordinateOf(body.latitude), coordinateOf(body.longitude));

    if (!point) {
      throw new WsException('Invalid GPS coordinates.');
    }

    const { latitude, longitude } = point;

    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      select: {
        id: true,
        clientId: true,
        artisanId: true,
        status: true,
      },
    });

    if (!intervention) {
      throw new WsException('Intervention introuvable.');
    }

    const isStaff = isTicketStaff(user.role);
    const isAssignedArtisan = intervention.artisanId === user.id;

    if (!isStaff && !isAssignedArtisan) {
      throw new WsException(
        'Vous ne pouvez pas envoyer la position pour cette intervention.',
      );
    }

    const artisanId = intervention.artisanId || user.id;

    // What the technician's own phone says is news (P3-05): it gets its time, it is kept in the history and it makes the position fresh.
    // A position sent by the staff for the technician is written as it always was, and is none of these: the phone did not say it, so
    // it does not make the technician look reachable and it does not enter the trail that is replayed for a dispute.
    const fromThePhone = user.role === Role.ARTISAN && user.id === artisanId;
    const plan = fromThePhone ? await planPing(this.prisma, artisanId, { latitude, longitude, accuracy: body.accuracy, speed: body.speed, heading: body.heading }, { interventionId }) : null;

    // One transaction: the position, its time and the history row are written together or not at all. A position the staff sends has no time:
    // it is not the phone's word, so it must not be taken for fresh (and an older time of the phone does not stay beside new coordinates).
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: {
          id: artisanId,
        },
        data: {
          latitude,
          longitude,
          positionAt: plan ? plan.positionAt : null,
        },
      }),

      ...(plan
        ? [
            this.prisma.artisanProfile.updateMany({
              where: {
                userId: artisanId,
              },
              data: {
                lastSeenAt: plan.positionAt,
              },
            }),
          ]
        : []),

      ...(plan?.history ? [this.prisma.artisanLocationPing.create({ data: plan.history })] : []),
    ]);

    const payload = {
      interventionId,
      artisanId,
      latitude,
      longitude,
      // What the customer's room receives is checked like what is stored: a number inside its range, else nothing.
      accuracy: optionalNumber(body.accuracy, 0, 100_000) ?? undefined,
      heading: optionalNumber(body.heading, 0, 360) ?? undefined,
      speed: optionalNumber(body.speed, 0, 200) ?? undefined,
      status: intervention.status,
      // A position the staff typed has no time of its own (the phone did not say it): null, so that nobody reads it as news.
      updatedAt: plan ? plan.positionAt : null,
    };

    // The back office follows the artisan all the time; the customer (and everybody else in the
    // room of the job) only while the artisan is on the way (P1-08), and only a position the technician's own phone sent: one the staff
    // typed in has no time, the pages of the customer refuse it for that reason, and the room must not hand it over as news.
    if (plan && artisanPositionIsShared(intervention.status)) {
      this.emitToIntervention(
        interventionId,
        'artisan.location.updated',
        payload,
      );
    }

    this.emitToAdmins('admin.artisan.location.updated', payload);

    return {
      success: true,
      payload,
    };
  }

  // ==========================================================
  // Server-side emit helpers
  // Used by RealtimeService and other modules
  // ==========================================================

  // Amounts are DECIMAL columns, and a Decimal travels as a text in JSON: every payload leaves with plain numbers (P2-01).
  // Chained .to(): socket.io sends to the union of the rooms, once per socket.
  // Two separate emits delivered every event twice to a socket in both rooms
  // (every admin is in 'admins' and 'admin-dashboard', every client in
  // both its client room and its user room).
  emitToAdmins(event: string, payload: any) {
    this.server.to('admins').to('admin-dashboard').emit(event, decimalsToNumbers(payload));
  }

  emitToUser(userId: number, event: string, payload: any) {
    this.server.to(this.userRoom(userId)).emit(event, decimalsToNumbers(payload));
  }

  emitToClient(clientId: number, event: string, payload: any) {
    this.server.to(this.clientRoom(clientId)).to(this.userRoom(clientId)).emit(event, decimalsToNumbers(payload));
  }

  emitToArtisan(artisanId: number, event: string, payload: any) {
    this.server.to(this.artisanRoom(artisanId)).to(this.userRoom(artisanId)).emit(event, decimalsToNumbers(payload));
  }

  /**
   * Takes every socket of a user out of the room of a job. The room is joined once, at the
   * moment the user is allowed in (the artisan of the job), and nothing else checks again:
   * an artisan who gave the job back, or lost it to a dispatcher, would go on receiving
   * everything said about the job (the client's phone and address, the next artisan).
   */
  removeUserFromIntervention(userId: number, interventionId: number) {
    this.server.in(this.userRoom(userId)).socketsLeave(this.interventionRoom(interventionId));
  }

  emitToIntervention(interventionId: number, event: string, payload: any) {
    this.server.to(this.interventionRoom(interventionId)).emit(event, decimalsToNumbers(payload));
  }

  emitStatusChange(payload: {
    interventionId: number;
    oldStatus?: Status | string | null;
    newStatus: Status | string;
    actorId?: number;
    changedAt?: Date;
  }) {
    // The room of the job has the customer and the artisan in it: the id of whoever made the
    // change goes to the dashboard only.
    const { actorId: _whoActed, ...forTheRoom } = payload;

    this.emitToIntervention(
      payload.interventionId,
      'intervention.status.changed',
      forTheRoom,
    );

    this.emitToAdmins('admin.intervention.status.changed', payload);
  }
}
