import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ActivateGuestAccountDto {
  // Token of the link sent to the guest's mailbox (it proves the e-mail address)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  token?: string;

  // Alternative: the code sent by SMS to the guest's phone (it proves the phone number)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  otp?: string;

  // Only for a profile made from a phone number alone (its address is made up and
  // nobody can log in with it): the address to log in with from now on. A profile
  // that already has a real address keeps it.
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsString()
  @MinLength(8)
  // The password goes through a slow hash: a megabyte of text must not be hashed.
  @MaxLength(128)
  @Matches(/[A-Z]/, {
    message: 'Le mot de passe doit contenir au moins une majuscule.',
  })
  @Matches(/[0-9]/, {
    message: 'Le mot de passe doit contenir au moins un chiffre.',
  })
  password: string;
}
