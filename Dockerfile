# Two stages: build the static UI, then a small runtime with only what the server needs (one runtime dependency: pg).
FROM node:24.13.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY ui ./ui
RUN npm run build

FROM node:24.13.0-slim
ENV NODE_ENV=production PORT=3000 FIRMHAND_DB=/tmp/firmhand/firmhand.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force && mkdir -p /tmp/firmhand && chown node /tmp/firmhand
COPY src ./src
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
# Storage: DATABASE_URL=postgres://... survives restarts and redeploys. Without it, FIRMHAND uses a SQLite file that
# lasts only as long as the container. Behind Render, set FIRMHAND_TRUST_PROXY_HOPS=3 (its edge adds the client plus two proxy hops).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
