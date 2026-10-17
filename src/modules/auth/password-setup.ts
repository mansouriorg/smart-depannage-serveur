import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { getFrontendUrl } from '../../config/env';
import { AuthTokenType } from '../../../generated/prisma/client';

/**
 * Accounts created on someone's behalf (artisan approved by an admin, staff
 * member, technician added from the dashboard) never get a password chosen by
 * us. They get a random, unusable one and a single-use link that lets the
 * owner choose their own (P0-04). The link goes through the regular
 * reset-password flow: POST /auth/reset-password { token, newPassword }.
 */

export const PASSWORD_SETUP_TTL_MS = 24 * 60 * 60 * 1000;

/** A password nobody knows and nobody is ever told. Hash it before storing. */
export function generateUnusablePassword(): string {
  return `Unusable-${crypto.randomBytes(48).toString('hex')}`;
}

/**
 * Creates a fresh single-use PASSWORD_RESET token for the user, revokes any
 * previous unused one, and returns the link to send to the user.
 * The raw token is returned once and only its sha256 hash is stored.
 */
export async function issuePasswordSetupLink(
  prisma: PrismaService,
  userId: number,
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  await prisma.authToken.updateMany({
    where: {
      userId,
      type: AuthTokenType.PASSWORD_RESET,
      usedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  await prisma.authToken.create({
    data: {
      userId,
      type: AuthTokenType.PASSWORD_RESET,
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_SETUP_TTL_MS),
    },
  });

  return `${getFrontendUrl()}/reset-password?token=${rawToken}`;
}
