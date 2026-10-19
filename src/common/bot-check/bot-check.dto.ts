import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The three fields the public request form adds for the bot check (P1-16). They are read by BotCheckGuard
 * before validation; they are declared here so the validation (which refuses unknown fields) lets them
 * through, and so the documentation names them. The services never use them.
 */
export class BotCheckFields {
  /** What GET /guest/challenge gave. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  botChallenge?: string;

  /** The number the page found for that challenge. */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  botSolution?: string;

  /** A hidden field: a person never fills it, a script does. Must be empty. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
