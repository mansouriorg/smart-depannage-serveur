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
  // Your routes will now start with /api (e.g., /api/interventions)
  // This is best practice for versioning your backend.
  app.setGlobalPrefix('api');

  // 3. Enable CORS (Cross-Origin Resource Sharing)
  // This allows your React/Next.js admin panel or mobile app to communicate with this API.
  app.enableCors({
    origin: '*', // ⚠️ In production, replace '*' with your actual frontend URL (e.g., 'https://smart-depannage.com')
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 4. Start the Server
  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}/api`);
}
bootstrap();