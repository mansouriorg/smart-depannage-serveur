import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { PrismaModule } from '../../prisma/prisma.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';

import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [
    PrismaModule,
    MulterModule.register({}),
    InterventionEventsModule,
  ],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}