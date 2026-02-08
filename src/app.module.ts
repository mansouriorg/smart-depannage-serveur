import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InterventionsModule } from './modules/interventions/interventions.module';

@Module({
  imports: [AuthModule, UsersModule, FilesModule, NotificationsModule, InterventionsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
