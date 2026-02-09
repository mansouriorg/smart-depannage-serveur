import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      // 1. Where to look for the token (Header: Authorization: Bearer <token>)
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      
      // 2. Don't allow expired tokens
      ignoreExpiration: false,
      
      // 3. ⚠️ FIX: use getOrThrow so TypeScript knows this will always be a string.
      // If JWT_SECRET is missing in .env, the app will fail to start (which is good).
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  // 4. Validate and transform the payload
  // The object returned here becomes 'req.user' in your Controllers.
  async validate(payload: any) {
    return { 
      userId: payload.sub, 
      email: payload.email, 
      role: payload.role // ✅ Critical for your Role Guards to work
    };
  }
}