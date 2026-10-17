import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { ContactChangeService } from './contact-change.service';
// We don't need to import PrismaModule here because it is marked as @Global() 
// in src/prisma/prisma.module.ts

@Module({
  controllers: [UsersController],
  providers: [UsersService, ContactChangeService],
  // ⚠️ CRITICAL: We export UsersService so the AuthModule can use it 
  // to find users and verify passwords.
  // ContactChangeService is exported for the admin dashboard, which can also
  // correct a customer's e-mail or phone (same rules: unique, announced).
  exports: [UsersService, ContactChangeService],
})
export class UsersModule {}
