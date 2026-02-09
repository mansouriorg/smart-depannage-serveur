import { PartialType } from '@nestjs/mapped-types';
import { CreateArtisanApplicationDto } from './create-artisan-application.dto';

export class UpdateArtisanApplicationDto extends PartialType(CreateArtisanApplicationDto) {}
