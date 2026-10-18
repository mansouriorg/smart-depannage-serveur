import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  API_DOCS_DESCRIPTION,
  API_DOCS_PATH,
  API_DOCS_TITLE,
  API_DOCS_VERSION,
} from './api-docs.config';

/** The OpenAPI document of the running application (every controller, DTO and route). */
export function buildOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle(API_DOCS_TITLE)
    .setDescription(API_DOCS_DESCRIPTION)
    .setVersion(API_DOCS_VERSION)
    .addBearerAuth()
    .build();

  return SwaggerModule.createDocument(app, config);
}

/**
 * Serves the documentation at /api/docs (page) and /api/docs/json (the document). Call it after
 * `setGlobalPrefix`, and only when `apiDocsEnabled(process.env)` says so.
 */
export function setupApiDocs(app: INestApplication): void {
  SwaggerModule.setup(API_DOCS_PATH, app, buildOpenApiDocument(app), {
    useGlobalPrefix: true,
    jsonDocumentUrl: `${API_DOCS_PATH}/json`,
  });
}
