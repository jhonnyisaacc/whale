FROM node:22-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-jayson-stream-json.mjs scripts/patch-jayson-stream-json.mjs
RUN npm ci --ignore-scripts && node scripts/patch-jayson-stream-json.mjs
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts/patch-jayson-stream-json.mjs scripts/patch-jayson-stream-json.mjs
RUN npm ci --omit=dev --ignore-scripts && node scripts/patch-jayson-stream-json.mjs
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/src/executor-server.js"]
