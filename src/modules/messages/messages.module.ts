import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  // RealtimeModule was missing: the @Optional() RealtimeService stayed
  // undefined and no message was ever pushed to a socket.
  imports: [PrismaModule, RealtimeModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
