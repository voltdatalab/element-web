# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
FROM node:26.7.0-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@12.11.2 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/agents/package.json ./apps/agents/package.json
RUN pnpm --filter @voltdatalab/element-agents install --prod --frozen-lockfile --ignore-scripts \
    && pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs
COPY apps/agents/src ./apps/agents/src
RUN mkdir /data && chown node:node /data
USER node
ENV ELEMENT_AGENTS_DEFAULT_STATE_DIR=/data HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "apps/agents/src/server.ts"]
