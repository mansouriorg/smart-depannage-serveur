import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class ActivateGuestAccountDto {
  // Magic link token from email/SMS
  @IsOptional()
  @IsString()
  token?: string;

  // OTP alternative
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  otp?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  @MinLength(8)
  @Matches(/[A-Z]/, {
    message: 'Le mot de passe doit contenir au moins une majuscule.',
  })
  @Matches(/[0-9]/, {
    message: 'Le mot de passe doit contenir au moins un chiffre.',
  })
  password: string;
}