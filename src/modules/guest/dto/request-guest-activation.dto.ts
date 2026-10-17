import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestGuestActivationDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}
