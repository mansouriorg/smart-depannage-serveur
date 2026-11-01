import { IsIn } from 'class-validator';

import { LOCALES } from '../../../common/i18n/i18n';

/** PATCH /users/me/locale: the language the person reads the app and the messages in. */
export class UpdateLocaleDto {
  @IsIn(LOCALES)
  locale: (typeof LOCALES)[number];
}
