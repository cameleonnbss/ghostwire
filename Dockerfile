# GhostWire - container image (userspace WireGuard, no privileges required)
FROM node:22-alpine

WORKDIR /app

# Dependencies first (better build cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Code + install scripts
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY install.sh LICENSE README.md .env.example ./

# wireproxy for linux/amd64 (image targets amd64; multi-arch possible via buildx)
RUN node bin/ghostwire.js setup && rm -rf bin/*.tar.gz

ENV GW_PORT=8080 \
    GW_HOST=0.0.0.0 \
    GW_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:${GW_PORT}/api/ping >/dev/null 2>&1 || exit 1

CMD ["node", "bin/ghostwire.js", "start"]
