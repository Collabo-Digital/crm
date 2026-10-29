import { Logger } from '@nestjs/common';
import type { ServeStaticModuleOptions } from '@nestjs/serve-static';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { SPA_FALLBACK_EXCLUDE } from './spa-fallback.util';

/**
 * The headers of the `/*` rule in the client build's `_headers` file
 * (client/public/_headers, plus the Content-Security-Policy the client build
 * adds to it): what Cloudflare sends with every page and file of the web app.
 */
export function readSpaHeaders(clientRoot: string): Array<[string, string]> {
  const file = join(clientRoot, '_headers');
  if (!existsSync(file)) return [];
  const headers: Array<[string, string]> = [];
  let everyPath = false;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('/') || /^https?:\/\//.test(line)) {
      everyPath = line === '/*';
      continue;
    }
    const colon = line.indexOf(':');
    if (everyPath && colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

/**
 * ServeStaticModule options for hosting the client build here
 * (SERVE_STATIC=true). The app's pages, its files and the index.html fallback
 * get the same headers as on Cloudflare, its Content-Security-Policy
 * included. API routes and /uploads are not served by this mount, so they
 * keep helmet's headers alone.
 */
export function spaStaticOptions(rootPath: string): ServeStaticModuleOptions {
  const headers = readSpaHeaders(rootPath);
  if (!headers.some(([name]) => name.toLowerCase() === 'content-security-policy')) {
    new Logger('SpaHosting').warn(
      `${join(rootPath, '_headers')} has no Content-Security-Policy, so the web app is served without one. Rebuild the client.`,
    );
  }
  return {
    rootPath,
    exclude: SPA_FALLBACK_EXCLUDE,
    serveStaticOptions: {
      setHeaders: (res: Response) => {
        for (const [name, value] of headers) res.setHeader(name, value);
      },
    },
  };
}
