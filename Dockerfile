FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install
COPY . .
RUN bun run build:browser

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json bun.lock ./
COPY src/node/main.ts ./src/node/main.ts
COPY src/index.ts ./src/index.ts
COPY src/api/api.ts ./src/api/api.ts
COPY src/auth.config.ts ./src/auth.config.ts
COPY tsconfig.json ./
RUN bun install --production
ENV PORT=3002
ENV GITHUB_CLIENT_ID=
ENV GITHUB_CLIENT_SECRET=
EXPOSE 3002
USER bun
CMD ["bun", "run", "src/node/main.ts"]
