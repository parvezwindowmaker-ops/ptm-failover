FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.11.2
COPY controller/package.json controller/pnpm-lock.yaml controller/pnpm-workspace.yaml ./
COPY controller/apps/api/package.json apps/api/package.json
COPY controller/apps/web/package.json apps/web/package.json
COPY controller/packages/contracts/package.json packages/contracts/package.json
COPY controller/packages/providers/package.json packages/providers/package.json
COPY controller/packages/routing/package.json packages/routing/package.json
COPY controller/packages/orchestrator/package.json packages/orchestrator/package.json
RUN pnpm install --frozen-lockfile
COPY controller/ ./
RUN pnpm run build && rm -rf node_modules && pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data AUTOMATION_DEFAULT=false
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/api/src/migrations ./apps/api/src/migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
