import { BadRequestException, CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';

import { BOT_CHECK_CODE, BOT_CHECK_MESSAGE, BOT_CHECK_PURPOSE_GUEST_CREATE } from './bot-check';
import { BotCheckService } from './bot-check.service';

/**
 * Refuses a public request that did not come with a solved challenge (P1-16).
 *
 * It reads the three fields of the body (`botChallenge`, `botSolution`, `website`) before the body is
 * validated, so a refused request costs no database work. Use it after RateLimitGuard, so every try is counted:
 *
 *   @UseGuards(RateLimitGuard, BotCheckGuard)
 */
@Injectable()
export class BotCheckGuard implements CanActivate {
  private readonly logger = new Logger(BotCheckGuard.name);

  constructor(private readonly botCheck: BotCheckService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const body = request.body && typeof request.body === 'object' ? request.body : {};

    const verdict = this.botCheck.verify(
      { challenge: body.botChallenge, solution: body.botSolution, honeypot: body.website },
      BOT_CHECK_PURPOSE_GUEST_CREATE,
    );

    if (verdict.ok === true) return true;

    // The reason stays in the log (our own wording, no personal data): the answer is the same for every reason.
    const { reason } = verdict;

    this.logger.warn(`Request refused by the bot check (${reason}).`);

    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: BOT_CHECK_CODE,
      message: BOT_CHECK_MESSAGE,
    });
  }
}
