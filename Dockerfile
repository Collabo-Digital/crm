# syntax=docker/dockerfile:1.6
# ──────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for Collabo CRM
#
# Builds the React client (SPA) and the NestJS server, then assembles a small
# runtime image where the NestJS server serves both /api/v1/* and the React
# static files. The container listens on port 80 so it can sit behind a
# Cloudflare proxy with no extra port mapping.
#
# Final layout inside the container:
#   /app/server/dist/src/main.js     ← NestJS entry point
#   /app/server/node_modules/        ← production deps
#   /app/server/prisma/              ← schema + migrations
#   /app/client/build/client/        ← built React SPA (served as static files)
# ──────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: Build the client (React SPA) ───────────────────────────────────
FROM node:24-alpine AS client-builder

WORKDIR /app/client

ARG VITE_META_APP_ID
ENV VITE_META_APP_ID=$VITE_META_APP_ID

# Install build deps (including devDependencies — needed for Vite/Tailwind)
COPY client/package.json client/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# Build the SPA → outputs to /app/client/build/client/
COPY client/ ./
RUN npm run build


# ─── Stage 2: Build the server (NestJS) ──────────────────────────────────────
FROM node:24-alpine AS server-builder

WORKDIR /app/server

# OpenSSL is required by Prisma
RUN apk add --no-cache openssl

# Install all deps (including devDependencies for nest build + prisma cli)
COPY server/package.json server/package-lock.json ./
RUN npm ci --legacy-peer-deps --include=dev --no-audit --no-fund

# Copy server source + Prisma schema
COPY server/ ./

# Generate Prisma client + compile NestJS to dist/
# DATABASE_URL is required by prisma.config.ts but only used at runtime,
# so we pass a dummy value here just to satisfy the config validator.
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate
RUN npm run build


# ─── Stage 3: Runtime image (small, production only) ─────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app/server

# OpenSSL for Prisma at runtime
RUN apk add --no-cache openssl

# Install only production dependencies (smaller image)
COPY server/package.json server/package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy compiled server output, Prisma client, schema, config, and built client
COPY --from=server-builder /app/server/dist ./dist
COPY --from=server-builder /app/server/node_modules/.prisma ./node_modules/.prisma
COPY --from=server-builder /app/server/node_modules/@prisma ./node_modules/@prisma
COPY --from=server-builder /app/server/prisma ./prisma
COPY --from=server-builder /app/server/prisma.config.ts ./prisma.config.ts
COPY --from=client-builder /app/client/build /app/client/build

# Install prisma CLI for 'migrate deploy' at startup
RUN npm install --no-save --no-audit --no-fund --legacy-peer-deps prisma@6

# Listen on port 80 so Cloudflare proxy can connect directly
ENV NODE_ENV=production
ENV PORT=80
# This image bundles the React SPA — enable ServeStaticModule
ENV SERVE_STATIC=true
EXPOSE 80

# Run migrations on container startup, then start the NestJS server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
