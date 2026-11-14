ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @praxis/api...
COPY apps/api/ apps/api/
RUN pnpm --filter @praxis/api build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PRAXIS_LAN_CONFIG=/config/server.json
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
USER node
EXPOSE 4318
CMD ["node", "apps/api/dist/main.js"]
