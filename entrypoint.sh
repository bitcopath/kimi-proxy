#!/bin/bash
# Seed Kimi Code config/auth dirs, then start the HTTP proxy.
set -euo pipefail

KIMI_CODE_HOME="${KIMI_CODE_HOME:-/root/.kimi-code}"
LEGACY_KIMI_HOME="${LEGACY_KIMI_HOME:-/root/.kimi}"

mkdir -p "$KIMI_CODE_HOME"

# Optional one-time seed from legacy kimi-cli home.
if [ -n "${HOST_KIMI_LEGACY_PATH:-}" ] || [ -d "$LEGACY_KIMI_HOME" ]; then
  if [ ! -f "$KIMI_CODE_HOME/config.toml" ] && [ -f "$LEGACY_KIMI_HOME/config.toml" ]; then
    echo "[entrypoint] Seeding config.toml from legacy home"
    cp "$LEGACY_KIMI_HOME/config.toml" "$KIMI_CODE_HOME/config.toml"
    sed -i 's/max_retries_per_step/max_attempts_per_step/g' "$KIMI_CODE_HOME/config.toml" || true
  fi

  if [ ! -f "$KIMI_CODE_HOME/credentials/kimi-code.json" ] \
     && [ -f "$LEGACY_KIMI_HOME/credentials/kimi-code.json" ]; then
    echo "[entrypoint] Seeding credentials from legacy home"
    mkdir -p "$KIMI_CODE_HOME/credentials"
    cp -a "$LEGACY_KIMI_HOME/credentials/." "$KIMI_CODE_HOME/credentials/"
  fi
fi

# Ensure binary is invokable even if a volume hid /root/.kimi-code/bin
if [ ! -x /usr/local/bin/kimi ] && [ -x "$KIMI_CODE_HOME/bin/kimi" ]; then
  install -m 755 "$KIMI_CODE_HOME/bin/kimi" /usr/local/bin/kimi
fi

if [ ! -x /usr/local/bin/kimi ]; then
  echo "[entrypoint] ERROR: Kimi CLI not found. Did the install step fail?" >&2
  exit 1
fi

echo "[entrypoint] KIMI_BIN=${KIMI_BIN:-/usr/local/bin/kimi}"
exec node /app/server.js
