import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { setupApiDocs } from './common/api-docs/api-docs';
import { apiDocsEnabled } from './common/api-docs/api-docs.config';
import {
  getAllowedOrigins,
  getFrontendUrl,
  parseTrustProxy,
} from './config/env';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // On SIGTERM (a deploy, a restart) let Nest call onModuleDestroy: the
  // delivery worker then finishes the message it is sending instead of being
  // cut off halfway, which could send it a second time after the restart.
  app.enableShutdownHooks();

  // Behind nginx / a load balancer, request.ip would be the proxy's address
  // for every client, which breaks the per-IP rate limits. Set TRUST_PROXY to
  // the number of proxies in front of the API (usually 1).
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

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

  // 2b. API documentation (P1-09): /api/docs. Off in production unless API_DOCS=true.
  if (apiDocsEnabled(process.env)) {
    setupApiDocs(app);
  }

  // 3. Enable CORS (Cross-Origin Resource Sharing)
  // Allowed origins come from the environment: FRONTEND_URL, the optional
  // CORS_ORIGINS list (admin dashboard, ...) and, outside production only,
  // the local development ports. See src/config/env.ts.
  app.enableCors({
    origin: getAllowedOrigins(),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // 4. Start the Server
  const port = process.env.PORT || 3000;

  // L'ajout de '0.0.0.0' permet au serveur d'accepter les connexions venant du réseau Wi-Fi.
  await app.listen(port, '0.0.0.0');

  if (!process.env.NODE_ENV) {
    logger.warn(
      'NODE_ENV is not set: the server runs in development mode (localhost CORS origins, shorter secrets allowed). Set NODE_ENV=production on the server.',
    );
  }

  if (process.env.NODE_ENV === 'production') {
    if (!getFrontendUrl().startsWith('https://')) {
      logger.warn(
        'FRONTEND_URL is not https: links sent to users (password reset, tracking) will not be secure.',
      );
    }

    if (trustProxy === undefined) {
      logger.warn(
        'TRUST_PROXY is not set. If the API runs behind nginx or a load balancer, every visitor shares the proxy address and the rate limits apply to all of them at once. Set TRUST_PROXY to the number of proxies (usually 1).',
      );
    }
  }

  logger.log(`Application is running on: http://localhost:${port}/api`);
  logger.log(`Network access (Mobile): http://YOUR_IP_ADDRESS:${port}/api`);
}
bootstrap();
