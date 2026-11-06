#!/bin/bash
set -euo pipefail

# Chandra-FRAYMUS VPS Deployment Script
# Target: Hostinger VPS (srv1944678.hstgr.cloud)
# Usage: ./deploy/deploy.sh [--production]

REMOTE_HOST="${DEPLOY_HOST:-srv1944678.hstgr.cloud}"
REMOTE_USER="${DEPLOY_USER:-root}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/chandra}"
BRANCH="${DEPLOY_BRANCH:-master}"
REPO="https://github.com/eyeoverthink/chandra-fraymus.git"

echo "=== Chandra-FRAYMUS Deploy ==="
echo "Target: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
echo "Branch: ${BRANCH}"
echo ""

# Pre-flight: ensure we're on the right branch and clean
if [ -d .git ]; then
  CURRENT=$(git rev-parse --abbrev-ref HEAD)
  if [ "$CURRENT" != "$BRANCH" ]; then
    echo "WARNING: local branch is '$CURRENT', deploying '$BRANCH'"
  fi
  DIRTY=$(git status --porcelain | wc -l)
  if [ "$DIRTY" -gt 0 ]; then
    echo "WARNING: $DIRTY uncommitted changes (deploy uses remote HEAD)"
  fi
fi

# Deploy commands sent to VPS via SSH
ssh "${REMOTE_USER}@${REMOTE_HOST}" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

DEPLOY_DIR="/opt/chandra"
REPO="https://github.com/eyeoverthink/chandra-fraymus.git"
BRANCH="master"

echo "[1/6] Ensuring Docker is installed..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

if ! docker compose version &>/dev/null; then
  echo "ERROR: docker compose plugin not found"
  exit 1
fi

echo "[2/6] Cloning/updating repository..."
if [ -d "$DEPLOY_DIR" ]; then
  cd "$DEPLOY_DIR"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"
fi

echo "[3/6] Creating .env if missing..."
if [ ! -f .env ]; then
  cat > .env <<'ENV'
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
CHANDRA_DATA_DIR=/opt/chandra/data
OLLAMA_BASE_URL=http://127.0.0.1:11434
ENV
  echo "Created .env — edit it to add SHOPIFY/PRINTIFY tokens if needed"
fi

echo "[4/6] Building Docker image..."
docker compose build --no-cache

echo "[5/6] Starting services..."
docker compose up -d

echo "[6/6] Verifying health..."
sleep 5
for i in 1 2 3 4 5; do
  if curl -sf http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    echo "Chandra is UP at port 8787"
    docker compose ps
    exit 0
  fi
  echo "  waiting... ($i/5)"
  sleep 3
done

echo "WARNING: health check failed after 5 attempts"
docker compose logs --tail=30
exit 1
REMOTE_SCRIPT

echo ""
echo "=== Deploy complete ==="
echo "Access: http://${REMOTE_HOST}:8787"
