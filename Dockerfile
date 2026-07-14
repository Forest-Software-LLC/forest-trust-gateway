# ───────────────────────────────────────────────────────────────────────────────
# 1) Build stage: install deps & compile TS
# ───────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.backend.json ./
RUN npm ci

COPY src ./src
RUN npm run build:backend
# only the Node/Fastify half — src/index.ts (the Worker shim) is bundled by
# `wrangler deploy` directly from source and never runs inside this image

# ───────────────────────────────────────────────────────────────────────────────
# 2) Production stage: slim runtime (for Cloudflare Containers)
# ───────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Non-root for security (supported by CF Containers)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
# Cloudflare Containers expect the app on 8080
ENV PORT=8080

EXPOSE 8080

# Ensure the server binds 0.0.0.0:8080 and exits cleanly on SIGTERM
CMD ["node", "dist/server.js"]
