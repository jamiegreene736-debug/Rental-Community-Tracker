FROM node:22-slim

RUN apt-get update && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Bake a copy of the committed static photos to /app/photos-seed so the
# startup script can populate the mounted volume on first boot. The volume
# mount at /app/client/public/photos shadows the baked-in files at that
# path, so we need a separate location that's never shadowed. See
# Load-Bearing Decision #17 in AGENTS.md.
RUN cp -R client/public/photos /app/photos-seed

ENV NODE_ENV=production

# Startup sequence:
#   1. Ensure the photos dir exists (first boot with fresh volume = empty).
#   2. Seed the volume from /app/photos-seed using `cp -Rn` — non-clobber,
#      so scraped photos from prior boots are preserved while any
#      newly-committed seed photos still land on fresh volumes.
#   3. Run drizzle db:push (Load-Bearing #15).
#   4. Start the server.
CMD ["sh", "-c", "mkdir -p /app/client/public/photos && cp -Rn /app/photos-seed/. /app/client/public/photos/ 2>/dev/null || true; npm run db:push && node dist/index.cjs"]
