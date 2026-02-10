import { 
  WebSocketGateway, 
  WebSocketServer, 
  SubscribeMessage, 
  MessageBody, 
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// ⚠️ CORS is crucial: origin: '*' allows your Frontend (Next.js) and Mobile apps to connect.
@WebSocketGateway({ 
  cors: { 
    origin: '*', 
  } 
})
export class InterventionsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  
  @WebSocketServer()
  server: Server;

  // --- LIFECYCLE HOOKS (Optional logging) ---
  afterInit(server: Server) {
    console.log('✅ WebSocket Gateway Initialized');
  }

  handleConnection(client: Socket) {
    console.log(`🔌 Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`❌ Client disconnected: ${client.id}`);
  }

  // ==========================================================
  // 1. BROADCAST NEW TICKET (Called by InterventionsService)
  // ==========================================================
  // This function is called by your Service whenever a new ticket is created.
  // It broadcasts the event to all connected clients (Admin Dashboard).
  sendNewIntervention(intervention: any) {
    this.server.emit('newIntervention', intervention);
  }

  // ==========================================================
  // 2. RECEIVE GPS POSITION (From Artisan App)
  // ==========================================================
  // The Artisan's phone sends: socket.emit('sendPosition', { artisanId: 1, lat: ..., lng: ... })
  @SubscribeMessage('sendPosition')
  handlePosition(
    @MessageBody() data: { artisanId: number, lat: number, lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    // Log to backend console for debugging
    console.log(`📍 Position received from Artisan #${data.artisanId}:`, data.lat, data.lng);

    // 🚀 BROADCAST TO ADMIN
    // This sends the data to everyone listening to 'tracking-update' (i.e., the Admin Dashboard Map)
    this.server.emit('tracking-update', data);
  }
}