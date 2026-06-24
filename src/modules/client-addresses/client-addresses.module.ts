import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ClientAddressesService } from './client-addresses.service';
import { ClientAddressesController } from './client-addresses.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ClientAddressesController],
  providers: [ClientAddressesService],
  exports: [ClientAddressesService],
})
export class ClientAddressesModule {}