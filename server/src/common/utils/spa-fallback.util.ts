/**
 * Paths the SPA's index.html fallback must not answer when the server also
 * hosts the client (SERVE_STATIC=true): the API, uploaded files, and missing
 * build assets, which should 404 rather than come back as HTML.
 *
 * @nestjs/serve-static matches these with path-to-regexp 8 (Express 5
 * syntax). The Express 4 form `/api/(.*)` throws there, on every request.
 */
export const SPA_FALLBACK_EXCLUDE = ['/api{/*path}', '/uploads{/*path}', '/assets{/*path}'];
