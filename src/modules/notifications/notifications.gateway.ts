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
import { getJwtAccessSecret, socketCorsOptions } from '../../config/env';

type SocketUser = {
  sub: number;
  email?: string;
  role: Role;
  tokenType?: string;
};

@Injectable()
@WebSocketGateway({
  namespace: 'notifications',
  cors: socketCorsOptions,
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
        secret: getJwtAccessSecret(),
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

  // There is deliberately no "emit to all admins": every admin has their own
  // notification (own id, own read state), so each one is sent to that admin's
  // room only. Broadcasting it to everyone would deliver N copies to each admin.
}
