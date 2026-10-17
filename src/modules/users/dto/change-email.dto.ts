import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /users/me/email-change */
export class ChangeEmailDto {
  @IsEmail()
  @MaxLength(254)
  newEmail: string;

  // Asked again even though the person is logged in: a stolen session must not be
  // enough to take over the address that password resets are sent to.
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  currentPassword: string;
}
