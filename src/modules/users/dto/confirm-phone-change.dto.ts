import { Matches } from 'class-validator';

/** POST /users/me/phone-change/confirm */
export class ConfirmPhoneChangeDto {
  @Matches(/^\d{6}$/, { message: 'Le code comporte 6 chiffres.' })
  code: string;
}
