import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UsersService } from '../../users/users.service';
import { getJwtAccessSecret } from '../../../config/env';
import { AuthenticatedUser } from '../types/authenticated-user.type';

type AccessTokenPayload = {
  sub: number;
  email: string;
  role: string;
  tokenType: 'access';
};

/**
 * The only JWT strategy of the application (P0-02).
 *
 * It verifies access tokens with JWT_ACCESS_SECRET, the same secret
 * AuthService signs them with, and re-reads the user on every request so a
 * deactivated or deleted account loses access immediately.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtAccessSecret(),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.tokenType !== 'access') {
      throw new UnauthorizedException('Token invalide.');
    }

    const user = await this.usersService.findActiveById(payload.sub);

    if (!user) {
      throw new UnauthorizedException('Utilisateur introuvable ou désactivé.');
    }

    return {
      id: user.id,
      // COMPATIBILITY SHIM: the legacy interventions controllers still read
      // `req.user.userId`. Remove together with the legacy routes (P3-03).
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }
}
