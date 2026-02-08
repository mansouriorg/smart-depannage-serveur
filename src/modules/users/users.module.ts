import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
// We don't need to import PrismaModule here because it is marked as @Global() 
// in src/prisma/prisma.module.ts

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  // ⚠️ CRITICAL: We export UsersService so the AuthModule can use it 
  // to find users and verify passwords.
  exports: [UsersService],
})
export class UsersModule {}