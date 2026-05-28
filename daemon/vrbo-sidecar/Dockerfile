# Sidecar worker image for VPS Docker deploy (Playwright CDP client only; browsers are separate chrome-server containers).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY daemon/vrbo-sidecar ./daemon/vrbo-sidecar

WORKDIR /app/daemon/vrbo-sidecar

CMD ["node", "supervisor.mjs"]
