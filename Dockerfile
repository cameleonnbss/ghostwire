# GhostWire — image conteneur (userspace, aucun privilège requis)
FROM node:22-alpine

WORKDIR /app

# Dépendances d'abord (meilleur cache de build)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Code + scripts d'install
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY install.sh LICENSE README.md .env.example ./

# wireproxy pour linux/amd64 (l'image cible amd64 ; buildx multi-arch possible)
RUN node bin/ghostwire.js setup && rm -rf bin/*.tar.gz

ENV GW_PORT=8080 \
    GW_HOST=0.0.0.0 \
    GW_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:${GW_PORT}/api/ping >/dev/null 2>&1 || exit 1

CMD ["node", "bin/ghostwire.js", "start"]
