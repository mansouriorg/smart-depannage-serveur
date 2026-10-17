import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Checks the tracking link BEFORE the request body is read.
 *
 * A guard runs before interceptors, and a file upload is read by an interceptor:
 * without this, somebody with a made-up link could make the server buffer
 * 25 MB of pictures only to be told "invalid link" afterwards. Here the answer
 * (the same 404 as everywhere else) comes first, and nothing is read.
 *
 * It only looks at `:id` and `?token=`; the service checks them again, with the
 * lock, when it stores anything.
 */
@Injectable()
export class GuestTrackingLinkGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const id = Number(request.params?.id);
    const token = request.query?.token;

    if (!Number.isInteger(id) || id <= 0 || typeof token !== 'string' || token.length === 0) {
      throw new NotFoundException('Lien de suivi invalide ou expiré.');
    }

    const found = await this.prisma.intervention.count({
      where: { id, trackingToken: crypto.createHash('sha256').update(token).digest('hex') },
    });

    if (!found) {
      throw new NotFoundException('Lien de suivi invalide ou expiré.');
    }

    return true;
  }
}
