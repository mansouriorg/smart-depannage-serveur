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

import {
  ArtisanLocationUpdateDto,
  JoinInterventionRoomDto,
  LeaveInterventionRoomDto,
} from './dto/realtime.dto';

import {
  Role,
  Status,
} from '../../../generated/prisma/client';

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
    const adminRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return adminRoles.includes(role);
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

    if (user.role !== Role.ARTISAN && !this.isAdminRole(user.role)) {
      throw new WsException('Only artisan or admin can update location.');
    }

    const interventionId = Number(body.interventionId);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new WsException('Invalid GPS coordinates.');
    }

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
    const isAssignedArtisan = intervention.artisanId === user.id;

    if (!isAdmin && !isAssignedArtisan) {
      throw new WsException(
        'Vous ne pouvez pas envoyer la position pour cette intervention.',
      );
    }

    const artisanId = intervention.artisanId || user.id;

    await this.prisma.user.update({
      where: {
        id: artisanId,
      },
      data: {
        latitude,
        longitude,
      },
    });

    await this.prisma.artisanProfile.updateMany({
      where: {
        userId: artisanId,
      },
      data: {
        lastSeenAt: new Date(),
      },
    });

    const payload = {
      interventionId,
      artisanId,
      latitude,
      longitude,
      accuracy: body.accuracy,
      heading: body.heading,
      speed: body.speed,
      status: intervention.status,
      updatedAt: new Date(),
    };

    this.emitToIntervention(
      interventionId,
      'artisan.location.updated',
      payload,
    );

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

  emitToAdmins(event: string, payload: any) {
    this.server.to('admins').emit(event, payload);
    this.server.to('admin-dashboard').emit(event, payload);
  }

  emitToUser(userId: number, event: string, payload: any) {
    this.server.to(this.userRoom(userId)).emit(event, payload);
  }

  emitToClient(clientId: number, event: string, payload: any) {
    this.server.to(this.clientRoom(clientId)).emit(event, payload);
    this.server.to(this.userRoom(clientId)).emit(event, payload);
  }

  emitToArtisan(artisanId: number, event: string, payload: any) {
    this.server.to(this.artisanRoom(artisanId)).emit(event, payload);
    this.server.to(this.userRoom(artisanId)).emit(event, payload);
  }

  emitToIntervention(interventionId: number, event: string, payload: any) {
    this.server.to(this.interventionRoom(interventionId)).emit(event, payload);
  }

  emitStatusChange(payload: {
    interventionId: number;
    oldStatus?: Status | string | null;
    newStatus: Status | string;
    actorId?: number;
    changedAt?: Date;
  }) {
    this.emitToIntervention(
      payload.interventionId,
      'intervention.status.changed',
      payload,
    );

    this.emitToAdmins('admin.intervention.status.changed', payload);
  }
}
