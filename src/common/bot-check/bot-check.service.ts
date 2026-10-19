import { Injectable } from '@nestjs/common';

import { getJwtAccessSecret } from '../../config/env';
import {
  BotCheckConfig,
  BotChecker,
  BotCheckInput,
  BotCheckVerdict,
  IssuedChallenge,
  botCheckSecret,
  readBotCheckConfig,
} from './bot-check';

/** The one checker of the process (it remembers the challenges already used). */
@Injectable()
export class BotCheckService {
  private readonly checker = new BotChecker({
    config: readBotCheckConfig(process.env),
    // Read on first use, so a process that has the check off never needs the secret.
    secret: (() => {
      let key: Buffer | null = null;

      return () => (key ??= botCheckSecret(process.env, getJwtAccessSecret));
    })(),
  });

  get config(): BotCheckConfig {
    return this.checker.config;
  }

  issue(purpose?: string): IssuedChallenge | { enabled: false } {
    return this.checker.issue(purpose);
  }

  verify(input: BotCheckInput, purpose?: string): BotCheckVerdict {
    return this.checker.verify(input, purpose);
  }
}
