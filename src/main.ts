import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // 1. Enable Global Validation
  // This ensures that all data coming into your endpoints (like requests for plumbers)
  // follows the rules defined in your DTOs.
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
  // Exemple Mobile : http://192.168.1.15:3000/api/auth/login
  app.setGlobalPrefix('api');

  // 3. Enable CORS (Cross-Origin Resource Sharing)
  // This allows your React/Next.js admin panel or mobile app to communicate with this API.
  app.enableCors({
    origin: '*', // ⚠️ In production, replace '*' with your actual frontend URL
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 4. Start the Server
  const port = process.env.PORT || 3000;

  // ✅ MISE À JOUR CRITIQUE ICI :
  // L'ajout de '0.0.0.0' permet au serveur d'accepter les connexions venant du réseau Wi-Fi (votre téléphone).
  await app.listen(port, '0.0.0.0');

  logger.log(`Application is running on: http://localhost:${port}/api`);
  logger.log(`Network access (Mobile): http://YOUR_IP_ADDRESS:${port}/api`);
}
bootstrap();