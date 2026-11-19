# syntax=docker/dockerfile:1
# Nhiều tầng: `web` (Next.js standalone, nhỏ gọn) và `worker` (có ffmpeg, chạy tiến trình nền + migration).
# Cả hai chạy bằng user không phải root.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- Cài phụ thuộc (gồm devDependencies vì worker chạy bằng tsx) ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- Build web ---
FROM deps AS build
COPY . .
RUN npm run build

# --- web ---
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# migration chạy lúc khởi động (instrumentation) và cần thư mục SQL
COPY --from=build --chown=node:node /app/src/lib/db/migrations ./src/lib/db/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# --- worker (và dịch vụ migrate dùng chung ảnh này) ---
FROM base AS worker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
USER node
CMD ["npx", "tsx", "src/worker/index.ts"]
