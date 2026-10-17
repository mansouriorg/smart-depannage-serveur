import { IsInt, Min, Max, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitFeedbackDto {
  @IsInt({ message: 'La note doit être un nombre entier.' })
  @Min(1, { message: 'La note minimum est de 1.' })
  @Max(5, { message: 'La note maximum est de 5.' })
  rating: number;

  @IsBoolean({ message: 'Veuillez indiquer si le technicien était à l\'heure.' })
  isOnTime: boolean;

  @IsOptional()
  @IsBoolean()
  hasIssue?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  feedbackNotes?: string;
}
