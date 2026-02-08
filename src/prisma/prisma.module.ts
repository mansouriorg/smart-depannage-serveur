import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // ⚠️ Important: Makes Prisma available everywhere without importing it repeatedly
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}