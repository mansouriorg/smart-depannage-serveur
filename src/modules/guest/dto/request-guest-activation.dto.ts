import { IsEmail, IsOptional, IsString } from 'class-validator';

export class RequestGuestActivationDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}