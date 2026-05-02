# syntax=docker/dockerfile:1.7-labs
FROM node:22-slim

RUN apt-get update && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Split the committed photo bundle from the rest of the source tree so
# the image only ships it once. The main COPY excludes
# client/public/photos; the second COPY places the same files at
# /app/photos-seed — the backup location the CMD seeds the Railway
# volume from on boot. Avoiding the duplicate keeps the image ~88MB
# smaller, which matters for Railway's snapshot/upload step. See
# Load-Bearing Decision #17 in AGENTS.md.
#
# Requires the BuildKit Dockerfile 1.7-labs frontend (the `# syntax=`
# line above). `--exclude` lives in the experimental/labs channel, not
# mainline 1.7 — the plain `1.7` tag will fail to parse this flag with
# "unknown flag: exclude". Promote to mainline when docker/dockerfile
# ships it there.
COPY --exclude=client/public/photos . .
COPY client/public/photos /app/photos-seed/

RUN npm run build

ENV NODE_ENV=production

# Startup sequence:
#   1. Ensure the photos dir exists (first boot with fresh volume = empty).
#   2. Seed the volume from /app/photos-seed using `cp -Rn` — non-clobber,
#      so scraped photos from prior boots are preserved while any
#      newly-committed seed photos still land on fresh volumes.
#   3. Start the server. Schema changes should be applied intentionally outside
#      container boot so Railway never hangs on an interactive data-loss prompt.
CMD ["sh", "-c", "mkdir -p /app/client/public/photos && cp -Rn /app/photos-seed/. /app/client/public/photos/ 2>/dev/null || true; node dist/index.cjs"]
