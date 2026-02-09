import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
// ⚠️ IMPORTANT: Import Role from your custom generated folder
// Adjust the number of '../' depending on where this file is located
import { Role } from '../../../../generated/prisma/client';

export class CreateUserDto {
  @IsEmail({}, { message: 'Please provide a valid email' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(Role, { message: 'Role must be CLIENT, ARTISAN, or ADMIN' })
  role: Role;

  @IsString()
  @IsNotEmpty()
  phone: string;
}