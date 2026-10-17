import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

import { PrismaService } from '../../prisma/prisma.service';
import { getJwtAccessSecret, socketCorsOptions } from '../../config/env';
import { Role } from '../../../generated/prisma/client';
import { isTicketStaff } from '../../common/auth/role-policy';
import { withoutStaffFields } from './intervention-redaction';

type AccessTokenPayload = {
  sub: number;
  tokenType?: string;
};

type SocketUser = {
  id: number;
  role: Role;
};

const STAFF_ROOM = 'staff';
const userRoom = (userId: number) => `user:${userId}`;

/**
 * Legacy realtime gateway (default namespace), still used by the admin
 * dashboard until the screens move to the `realtime` namespace.
 *
 * P0-05: it used to accept any anonymous socket, with CORS "*", broadcast
 * every new ticket (client name and phone) to everybody, and rebroadcast the
 * artisan id, latitude and longitude that the sender typed. Now:
 *   - the JWT access token is required to connect;
 *   - events go to rooms (staff, or the people concerned), never to everyone;
 *   - the artisan id of a position comes from the token, not from the payload.
 */
@WebSocketGateway({
  cors: socketCorsOptions,
})
export class InterventionsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(InterventionsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  // ==========================================================
  // CONNECTION: JWT required
  // The token is read from `auth: { token }` (socket.io client option) or the
  // Authorization header.
  // ==========================================================

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token;

    if (typeof authToken === 'string' && authToken) {
      return authToken.replace(/^Bearer\s+/i, '');
    }

    const header = client.handshake.headers.authorization;

    if (typeof header === 'string' && header) {
      return header.replace(/^Bearer\s+/i, '');
    }

    return undefined;
  }

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);

      if (!token) {
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify<AccessTokenPayload>(token, {
        secret: getJwtAccessSecret(),
      });

      if (!payload?.sub || payload.tokenType !== 'access') {
        client.disconnect(true);
        return;
      }

      const user = await this.prisma.user.findFirst({
        where: { id: payload.sub, isActive: true, deletedAt: null },
        select: { id: true, role: true },
      });

      if (!user) {
        client.disconnect(true);
        return;
      }

      client.data.user = { id: user.id, role: user.role } satisfies SocketUser;

      client.join(userRoom(user.id));

      if (isTicketStaff(user.role)) {
        client.join(STAFF_ROOM);
      }
    } catch {
      // Invalid or expired token: refuse silently, never log the token.
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  // ==========================================================
  // 1. NEW TICKET → staff only
  // ==========================================================

  sendNewIntervention(intervention: any) {
    this.server.to(STAFF_ROOM).emit('newIntervention', intervention);
  }

  // ==========================================================
  // 2. STATUS CHANGE → staff + the client and artisan of the ticket
  // ==========================================================

  sendInterventionStatus(intervention: {
    id: number;
    clientId?: number | null;
    artisanId?: number | null;
  }) {
    const event = `interventionStatus-${intervention.id}`;

    // Staff get the whole row.
    this.server.to(STAFF_ROOM).emit(event, intervention);

    // The client and the artisan of the ticket get it without staff notes and
    // the tracking token hash.
    const participants = [intervention.clientId, intervention.artisanId]
      .filter((id): id is number => typeof id === 'number')
      .map(userRoom);

    if (participants.length > 0) {
      this.server.to(participants).emit(event, withoutStaffFields(intervention));
    }
  }

  // ==========================================================
  // 3. ISSUE REPORTED ON A TICKET → staff only
  // ==========================================================

  sendInterventionIssue(payload: any) {
    this.server.to(STAFF_ROOM).emit('interventionIssue', payload);
  }

  // ==========================================================
  // 4. GPS POSITION from the artisan app → staff only
  // The artisan is the authenticated user. A position claiming to come from
  // another artisan is impossible because the payload's artisanId is ignored.
  // ==========================================================

  @SubscribeMessage('sendPosition')
  handlePosition(
    @MessageBody() data: { lat: number; lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    const user = client.data.user as SocketUser | undefined;

    if (!user || user.role !== Role.ARTISAN) {
      return { ok: false, error: 'FORBIDDEN' };
    }

    // Number(null) and Number('') are 0: only real numbers are positions.
    if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') {
      return { ok: false, error: 'INVALID_POSITION' };
    }

    const lat = data.lat;
    const lng = data.lng;

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return { ok: false, error: 'INVALID_POSITION' };
    }

    this.server.to(STAFF_ROOM).emit('tracking-update', {
      artisanId: user.id,
      lat,
      lng,
      at: new Date().toISOString(),
    });

    return { ok: true };
  }
}
