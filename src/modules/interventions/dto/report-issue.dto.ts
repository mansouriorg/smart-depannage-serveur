import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ReportIssueDto {
  @IsString()
  @IsNotEmpty()
  // Public route (the tracking link): the text is appended to the request's notes, so it has a ceiling.
  @MaxLength(1000)
  issueDescription: string;
}
