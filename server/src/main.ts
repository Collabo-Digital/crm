import './instrumentation';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import type { IncomingMessage } from 'node:http';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { constants as zlibConstants } from 'node:zlib';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import { EXPORT_EXPOSED_HEADERS } from './common/utils/export-headers.util';

const API_PREFIX = 'api/v1';
const PIXEL_ROUTE_PREFIX = `/${API_PREFIX}/analytics/pixel`;
const WIDGET_ROUTE_PREFIX = `/${API_PREFIX}/widget/`;

/// Express defaults to 100kb, which a Shopify order webhook for a large cart
/// exceeds — and the 413 is raised BEFORE HMAC verification, so the handler
/// never runs and we cannot even log the miss. Shopify counts those as failed
/// deliveries and eventually DELETES the subscription, silently stopping sync.
const REQUEST_BODY_LIMIT = '2mb';
/// Meta's webhooks go up to 3 MB (WhatsApp Business app history chunks are
/// the largest), and a 413 is raised before the signature is even checked.
const META_WEBHOOK_PATHS = [
  `/${API_PREFIX}/webhooks/whatsapp`,
  `/${API_PREFIX}/webhooks/messenger`,
  `/${API_PREFIX}/webhooks/instagram`,
];
const META_WEBHOOK_BODY_LIMIT = '5mb';

const CORS_PREFLIGHT_CACHE_SECONDS = 86400;
const COMPRESSION_MIN_BYTES = 1024;
const GZIP_LEVEL = 6;
const BROTLI_QUALITY = 4;
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

function applySecurityMiddleware(app: NestExpressApplication) {
  const trustedProxyHops = Number(process.env.TRUST_PROXY);
  if (trustedProxyHops > 0) app.set('trust proxy', trustedProxyHops);

  // API responses (JSON, files, PDFs) carry no page policy. The web app's
  // Content-Security-Policy comes with its build (client/public/_headers):
  // Cloudflare sends it, and with SERVE_STATIC=true so does the SPA mount in
  // app.module.ts, for the app's pages and files only.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
}

function applyCompression(app: NestExpressApplication) {
  // Response compression lives here, not in Caddy: only the DigitalOcean
  // deploy has a proxy in front, while the single-container compose, Render
  // and Railway shapes hit Node directly. Caddy passes an already-encoded
  // response through untouched, so nothing is compressed twice.
  // Brotli quality is pinned because zlib's default (11) is tuned for
  // static assets and is far too slow for per-request JSON.
  app.use(
    compression({
      threshold: COMPRESSION_MIN_BYTES, // webhook acks, pixel hits and health checks stay raw
      level: GZIP_LEVEL,
      brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
      // Server-sent events must reach the browser as they happen; compression
      // would hold each small event back until its buffer filled.
      filter: (request, response) =>
        !String(response.getHeader('Content-Type') ?? '').includes(EVENT_STREAM_CONTENT_TYPE) &&
        !(request.headers.accept ?? '').includes(EVENT_STREAM_CONTENT_TYPE) &&
        compression.filter(request, response),
    }),
  );
}

/// Pixel ingest and the website widget must accept any storefront origin;
/// everything else stays locked to the CRM frontend.
function applyCors(app: NestExpressApplication, frontendUrl: string) {
  const createPublicCorsOptions = (methods: string[]): CorsOptions => ({
    origin: true,
    credentials: false,
    methods,
    maxAge: CORS_PREFLIGHT_CACHE_SECONDS,
  });

  const pixelCorsOptions = createPublicCorsOptions(['POST', 'OPTIONS']);
  // Sign-ups check each widget's allowed domains.
  const widgetCorsOptions = createPublicCorsOptions(['GET', 'POST', 'OPTIONS']);
  const frontendCorsOptions: CorsOptions = {
    origin: frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: EXPORT_EXPOSED_HEADERS,
    maxAge: CORS_PREFLIGHT_CACHE_SECONDS,
  };

  app.enableCors((request: IncomingMessage, applyCorsOptions) => {
    if (request.url?.startsWith(PIXEL_ROUTE_PREFIX)) {
      applyCorsOptions(null, pixelCorsOptions);
    } else if (request.url?.startsWith(WIDGET_ROUTE_PREFIX)) {
      applyCorsOptions(null, widgetCorsOptions);
    } else {
      applyCorsOptions(null, frontendCorsOptions);
    }
  });
}

function applyBodyParsers(app: NestExpressApplication) {
  app.use(
    META_WEBHOOK_PATHS,
    json({
      limit: META_WEBHOOK_BODY_LIMIT,
      verify: (request: RawBodyRequest<IncomingMessage>, _response, rawBodyBuffer) => {
        request.rawBody = rawBodyBuffer;
      },
    }),
  );
  app.useBodyParser('json', { limit: REQUEST_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: REQUEST_BODY_LIMIT, extended: true });
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  applySecurityMiddleware(app);
  applyCompression(app);
  applyCors(app, configService.getOrThrow<string>('frontendUrl'));
  applyBodyParsers(app);

  app.setGlobalPrefix(API_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

  await app.listen(configService.getOrThrow<number>('port'));
}

bootstrap().catch((error) => {
  console.error('API failed to start', error);
  process.exit(1);
});