import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { Server, Socket } from 'socket.io';

import { Role } from '../../../generated/prisma/client';

type SocketUser = {
  sub: number;
  email?: string;
  role: Role;
  tokenType?: string;
};

@Injectable()
@WebSocketGateway({
  namespace: 'notifications',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

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

  async handleConnection(client: Socket) {
    try {
      const token = this.getToken(client);

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify<SocketUser>(token, {
        secret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_me',
      });

      if (!payload?.sub || payload.tokenType !== 'access') {
        client.disconnect();
        return;
      }

      client.data.user = {
        id: payload.sub,
        role: payload.role,
      };

      client.join(`user:${payload.sub}`);

      if (this.isAdminRole(payload.role)) {
        client.join('admins');
      }

      client.emit('notifications.connected', {
        userId: payload.sub,
        role: payload.role,
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

  emitToUser(userId: number, event: string, payload: any) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  emitToAdmins(event: string, payload: any) {
    this.server.to('admins').emit(event, payload);
  }
}