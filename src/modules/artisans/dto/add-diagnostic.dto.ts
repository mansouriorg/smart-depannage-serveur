import { IsString } from 'class-validator';

export class AddDiagnosticDto {
  @IsString()
  diagnosticNotes: string;
}