import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { readSpaHeaders, spaStaticOptions } from './spa-headers.util';

/**
 * Combined hosting (SERVE_STATIC=true): the same two ServeStaticModule mounts
 * as AppModule, booted the way main.ts boots it (NestFactory picks the
 * serve-static loader from the HTTP adapter, which a testing module does not
 * have yet). A deep link must get the SPA, and the API and uploads must never
 * be answered with index.html. The app's pages and files carry the build's
 * _headers (its Content-Security-Policy); API routes and uploads do not.
 */

const INDEX = '<!doctype html><title>spa-index</title>';
const POLICY = "default-src 'self'; frame-ancestors 'none'";
const HEADERS = `# comment\n/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: ${POLICY}\n/assets/*\n  Cache-Control: immutable\n`;

@Controller('health')
class HealthController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('SPA fallback with SERVE_STATIC=true', () => {
  let dir: string;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'spa-fallback-'));
    const client = join(dir, 'client');
    const uploads = join(dir, 'uploads');
    mkdirSync(join(client, 'assets'), { recursive: true });
    mkdirSync(uploads);
    writeFileSync(join(client, 'index.html'), INDEX);
    writeFileSync(join(client, '_headers'), HEADERS);
    writeFileSync(join(client, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(uploads, 'shirt.png'), 'png-bytes');

    @Module({
      imports: [
        ServeStaticModule.forRoot(spaStaticOptions(client)),
        ServeStaticModule.forRoot({ rootPath: uploads, serveRoot: '/uploads' }),
      ],
      controllers: [HealthController],
    })
    class SpaHostingModule {}

    app = await NestFactory.create(SpaHostingModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
    server = app.getHttpServer() as typeof server;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['/', '/app/products/123', '/auth/login', '/apiary'])('serves the SPA for %s', async (path) => {
    const res = await request(server).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX);
  });

  it('serves built assets', async () => {
    const res = await request(server).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log(1)');
  });

  it('lets API routes through to Nest', async () => {
    const res = await request(server).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('serves uploaded files', async () => {
    const res = await request(server).get('/uploads/shirt.png');
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('png-bytes');
  });

  it.each(['/', '/app/products/123', '/auth/login', '/assets/app.js'])('sends the app\'s security headers with %s', async (path) => {
    const res = await request(server).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(POLICY);
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it.each(['/api/v1/health', '/uploads/shirt.png'])('leaves the page policy off %s', async (path) => {
    const res = await request(server).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it.each(['/api', '/api/v1/no-such-route', '/uploads/missing.png', '/assets/old-build.js'])(
    'answers %s with a 404, not the SPA',
    async (path) => {
      const res = await request(server).get(path);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('spa-index');
    },
  );
});

describe('readSpaHeaders', () => {
  it("reads only the /* rule of the build's _headers", () => {
    const dir = mkdtempSync(join(tmpdir(), 'spa-headers-'));
    try {
      writeFileSync(join(dir, '_headers'), HEADERS);
      expect(readSpaHeaders(dir)).toEqual([
        ['X-Frame-Options', 'DENY'],
        ['Content-Security-Policy', POLICY],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is empty for a build without _headers', () => {
    expect(readSpaHeaders(join(tmpdir(), 'no-such-client-build'))).toEqual([]);
  });
});
