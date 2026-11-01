# Stage 1: Build the Vite client
FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Production server
FROM node:22-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    libvips-dev \
    chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY agents/ ./agents/
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV CHANDRA_DATA_DIR=/app/data

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "server/start.js"]
