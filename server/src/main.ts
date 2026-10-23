import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { constants as zlibConstants } from 'node:zlib';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import { EXPORT_EXPOSED_HEADERS } from './common/utils/export-headers.util';

/// Express defaults to 100kb, which a Shopify order webhook for a large cart
/// exceeds — and the 413 is raised BEFORE HMAC verification, so the handler
/// never runs and we cannot even log the miss. Shopify counts those as failed
/// deliveries and eventually DELETES the subscription, silently stopping sync.
const REQUEST_BODY_LIMIT = '2mb';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);

  const trustProxy = Number(process.env.TRUST_PROXY);
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  // Security
  app.use(helmet({
    contentSecurityPolicy: false, // Vite build injects inline scripts/styles
  }));
  app.use(cookieParser());

  // Response compression lives here, not in Caddy: only the DigitalOcean
  // deploy has a proxy in front, while the single-container compose, Render
  // and Railway shapes hit Node directly. Caddy passes an already-encoded
  // response through untouched, so nothing is compressed twice.
  // Brotli quality is pinned because zlib's default (11) is tuned for
  // static assets and is far too slow for per-request JSON.
  app.use(
    compression({
      threshold: 1024, // webhook acks, pixel hits and health checks stay raw
      level: 6,
      brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
      // Server-sent events must reach the browser as they happen; compression
      // would hold each small event back until its buffer filled.
      filter: (req, res) =>
        !String(res.getHeader('Content-Type') ?? '').includes('text/event-stream') &&
        !(req.headers.accept ?? '').includes('text/event-stream') &&
        compression.filter(req, res),
    }),
  );

  // Must precede route handling. `rawBody: true` above still captures the
  // untouched buffer the Shopify HMAC check needs — up to this same limit.
  app.useBodyParser('json', { limit: REQUEST_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: REQUEST_BODY_LIMIT, extended: true });

  // CORS — pixel ingest and the website widget must accept any storefront
  // origin; everything else stays locked to the CRM frontend.
  app.enableCors((req, cb) => {
    if (req.url?.startsWith('/api/v1/analytics/pixel')) {
      cb(null, { origin: true, credentials: false, methods: ['POST', 'OPTIONS'], maxAge: 86400 });
    } else if (req.url?.startsWith('/api/v1/widget/')) {
      // The website widget runs on merchants' own sites; sign-ups check each widget's allowed domains.
      cb(null, { origin: true, credentials: false, methods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 });
    } else {
      cb(null, {
        origin: config.get<string>('frontendUrl'),
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        // The app is on another origin, so the browser hides these from it
        // unless exposed — and the "file was cut off" notice never fires.
        exposedHeaders: EXPORT_EXPOSED_HEADERS,
        maxAge: 86400,
      });
    }
  });

  // API versioning
  app.setGlobalPrefix('api/v1');

  // Global validation — strips unknown props, rejects non-whitelisted, auto-transforms
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Graceful shutdown
  app.enableShutdownHooks();

  const port = config.get<number>('port')!;
  await app.listen(port);
}

bootstrap();