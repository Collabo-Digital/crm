# syntax=docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021
# ──────────────────────────────────────────────────────────────────────────────
# Server-only Dockerfile for the NestJS API.
#
# Use this for deployments where the frontend lives elsewhere (e.g. Cloudflare
# Pages) and only the API needs to run. The full-stack version of the
# Dockerfile (with the React SPA bundled in) lives at the repo root.
#
# Final image listens on port 80 so it can sit directly behind a Cloudflare
# proxy (no port mapping required).
# ──────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: Build ──────────────────────────────────────────────────────────
# Base images are pinned by digest (the tag is there to read); see
# docs/deploy-hardening.md to move them to a newer image.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

WORKDIR /app

# Prisma needs OpenSSL on Alpine
RUN apk add --no-cache openssl

# Install all deps (devDependencies are needed for nest build + prisma cli)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --include=dev --no-audit --no-fund

# Copy source + Prisma schema
COPY . ./

# Generate Prisma client + compile NestJS to dist/
# DATABASE_URL is required by prisma.config.ts but only used at runtime,
# so we pass a dummy value here just to satisfy the config validator.
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate
RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime

WORKDIR /app

# Prisma + healthcheck use these; ffmpeg converts inbox voice notes
RUN apk add --no-cache openssl wget ffmpeg

# Install only production dependencies (smaller image)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy compiled output, Prisma client, schema, and config
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Install prisma CLI (small) so 'prisma migrate deploy' works at startup
# without npx having to download it on every container start.
RUN npm install --no-save --no-audit --no-fund --legacy-peer-deps prisma@6

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

# Run pending migrations on startup, then launch the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
