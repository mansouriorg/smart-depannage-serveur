import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ServiceZonesController } from './service-zones.controller';
import { ServiceZonesService } from './service-zones.service';

@Module({
  imports: [PrismaModule],
  controllers: [ServiceZonesController],
  providers: [ServiceZonesService],
  exports: [ServiceZonesService],
})
export class ServiceZonesModule {}
