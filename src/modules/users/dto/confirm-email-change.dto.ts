import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /users/email-change/confirm (the token of the link sent to the new address) */
export class ConfirmEmailChangeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token: string;
}
