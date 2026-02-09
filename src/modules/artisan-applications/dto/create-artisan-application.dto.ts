import { IsEmail, IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateArtisanApplicationDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsString()
  phone: string;

  @IsNotEmpty()
  @IsString()
  specialty: string; // e.g. "Plumber"

  @IsInt()
  @Min(0)
  experience: number; // Years

  @IsString()
  description?: string;
}