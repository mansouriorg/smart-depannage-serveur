import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // 1. Enable Global Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Automatically strip properties that strictly don't belong to the DTO
      forbidNonWhitelisted: true, // Throw an error if non-whitelisted values are provided
      transform: true, // Automatically transform payloads to be objects typed according to their DTO classes
    }),
  );

  // 2. Set Global Prefix
  // ⚠️ ATTENTION : Vos routes commencent maintenant par /api
  // Exemple Web : http://localhost:3000/api/auth/login
  app.setGlobalPrefix('api');

  // 3. Enable CORS (Cross-Origin Resource Sharing)
  // 🚨 CORRECTION CRITIQUE ICI :
  // On ne peut pas mettre '*' ET credentials: true en même temps.
  // Il faut lister explicitement les adresses de votre Frontend (Next.js).
  app.enableCors({
    origin: [
      'http://localhost:3000', // Backend (parfois utile)
      'http://localhost:3001', // 👈 Votre Admin Panel Next.js (Port par défaut)
      'http://localhost:3002', // Au cas où le port 3001 est pris
      'http://127.0.0.1:3000', 
      'http://127.0.0.1:3001',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true, // ✅ Maintenant autorisé car on a défini des origines précises
  });

  // 4. Start the Server
  const port = process.env.PORT || 3000;

  // L'ajout de '0.0.0.0' permet au serveur d'accepter les connexions venant du réseau Wi-Fi.
  await app.listen(port, '0.0.0.0');

  logger.log(`Application is running on: http://localhost:${port}/api`);
  logger.log(`Network access (Mobile): http://YOUR_IP_ADDRESS:${port}/api`);
}
bootstrap();