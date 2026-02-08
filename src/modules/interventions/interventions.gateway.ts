import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*', // ⚠️ Allow all origins for development (update in production)
  },
})
export class InterventionsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('InterventionsGateway');

  // 1. Handle Connection
  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    // Ideally, you would verify the JWT token here to know WHO connected
    // e.g., const token = client.handshake.headers.authorization;
  }

  // 2. Handle Disconnect
  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // 3. Custom Event: Join Room (Optional)
  // Useful if you only want Artisans to hear about jobs in "Tunis", etc.
  @SubscribeMessage('joinRoom')
  handleJoinRoom(client: Socket, room: string) {
    client.join(room);
    this.logger.log(`Client ${client.id} joined room ${room}`);
  }

  // 4. Helper Method: Send Notification
  // Call this method from your Service whenever a new request is created
  notifyNewIntervention(intervention: any) {
    this.server.emit('newIntervention', intervention);
  }
}