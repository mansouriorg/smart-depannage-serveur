import { IsOptional, IsString, MaxLength } from 'class-validator';

/** PATCH /artisan-applications/:id/approve (the body is optional) */
export class ApproveArtisanApplicationDto {
  // The number the technician's account gets, when the one typed on the form cannot
  // be used (not a phone number, or another account already has it).
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;
}
