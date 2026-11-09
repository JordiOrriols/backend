# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS scheduler
WORKDIR /planner
COPY --from=planner package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=github_token,required=true \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm ci
COPY --from=planner src ./src
COPY --from=planner scripts ./scripts
COPY --from=planner tsconfig.json ./
RUN npm run build:scheduler

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY --from=scheduler /planner/dist-scheduler/roadmap.mjs ./dist/scheduler.mjs

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
