import { IsString, IsNotEmpty } from 'class-validator';

export class ReportIssueDto {
  @IsString()
  @IsNotEmpty()
  issueDescription: string;
}