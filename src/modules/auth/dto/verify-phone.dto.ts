import { IsString, Length } from 'class-validator';

export class VerifyPhoneDto {
  @IsString()
  @Length(6, 6)
  code: string;
}