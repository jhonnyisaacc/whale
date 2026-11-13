FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.json
COPY web ./web
RUN pnpm --filter @whale/web run build

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
ENV NODE_ENV=production COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod --filter whale && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "dist/src/executor-server.js"]
