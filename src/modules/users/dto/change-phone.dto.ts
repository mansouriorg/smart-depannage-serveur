import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /users/me/phone-change */
export class ChangePhoneDto {
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  newPhone: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  currentPassword: string;
}
