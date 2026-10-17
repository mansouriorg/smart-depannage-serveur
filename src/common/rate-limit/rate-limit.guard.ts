import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RateLimitService } from './rate-limit.service';
import { WindowRule } from './rate-limiter';

export const RATE_LIMIT_KEY = 'rate_limit';

export type RateLimitOptions = WindowRule & {
  /** Bucket name, so two routes never share a counter by accident. */
  name: string;
};

/**
 * Per-client-IP limit on a route. Use together with RateLimitGuard:
 *
 *   @UseGuards(RateLimitGuard)
 *   @RateLimit({ name: 'login', limit: 20, windowMs: 15 * 60_000 })
 *
 * Per-account protections (lockout after failures) are applied inside the
 * services, because only they know whether an attempt failed.
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private warnedAboutProxy = false;

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) return true;

    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    // request.ip honours the "trust proxy" setting (see TRUST_PROXY in main.ts)
    const ip: string = request.ip || request.socket?.remoteAddress || 'unknown';

    // A proxy adds X-Forwarded-For. If the server does not trust it, every
    // visitor looks like the proxy: one person could use up the limit (and the
    // per-address login lockout) of everybody. Say so once, loudly.
    if (
      !this.warnedAboutProxy &&
      request.headers?.['x-forwarded-for'] &&
      !request.app?.get?.('trust proxy')
    ) {
      this.warnedAboutProxy = true;
      this.logger.warn(
        'Requests carry X-Forwarded-For but TRUST_PROXY is not set: all visitors share the proxy address for rate limits and login lockouts. Set TRUST_PROXY to the number of proxies in front of the API.',
      );
    }
    const result = this.rateLimit.consume(`ip:${options.name}:${ip}`, options);

    if (!result.allowed) {
      // Time left in the current window, not the whole window.
      const retryAfterSeconds = Math.max(Math.ceil(result.retryAfterMs / 1000), 1);

      response?.setHeader?.('Retry-After', String(retryAfterSeconds));

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Trop de requêtes. Réessayez plus tard.',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
