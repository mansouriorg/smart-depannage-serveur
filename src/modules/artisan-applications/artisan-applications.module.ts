import { Module } from '@nestjs/common';
import { ArtisanApplicationsService } from './artisan-applications.service';
import { ArtisanApplicationsController } from './artisan-applications.controller';

@Module({
  controllers: [ArtisanApplicationsController],
  providers: [ArtisanApplicationsService],
})
export class ArtisanApplicationsModule {}
