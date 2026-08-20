#!/usr/bin/env bash
#
# Downloads and extracts the Joplin desktop AppImage used by the real-app E2E tests.
# Idempotent: skips the download/extract if the extracted Electron binary already exists.
#
# Override the version with JOPLIN_E2E_VERSION (must be >= the plugin's app_min_version).
#
set -euo pipefail

JOPLIN_VERSION="${JOPLIN_E2E_VERSION:-3.6.14}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.e2e-cache"
APPIMAGE="$CACHE_DIR/Joplin.AppImage"
BINARY="$CACHE_DIR/squashfs-root/joplin"
URL="https://github.com/laurent22/joplin/releases/download/v${JOPLIN_VERSION}/Joplin-${JOPLIN_VERSION}.AppImage"

mkdir -p "$CACHE_DIR"

if [ -x "$BINARY" ]; then
  echo "[setup-e2e] Joplin already extracted at $BINARY — nothing to do."
  exit 0
fi

if [ ! -f "$APPIMAGE" ]; then
  echo "[setup-e2e] Downloading Joplin $JOPLIN_VERSION ..."
  # -f: fail (non-zero exit) on an HTTP error such as a 404 for a mistyped/withdrawn version, rather
  # than silently saving the error page as "Joplin.AppImage" and failing confusingly at extract time.
  # --retry: ride out transient network/CDN blips. rm on failure so a partial file is not cached.
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$APPIMAGE" "$URL"; then
    echo "[setup-e2e] ERROR: failed to download Joplin $JOPLIN_VERSION from $URL" >&2
    rm -f "$APPIMAGE"
    exit 1
  fi
  # A valid AppImage is well over 100 MB; anything tiny is an error page that slipped through.
  if [ "$(stat -c%s "$APPIMAGE" 2>/dev/null || echo 0)" -lt 10000000 ]; then
    echo "[setup-e2e] ERROR: downloaded AppImage is implausibly small — treating as a failed download" >&2
    rm -f "$APPIMAGE"
    exit 1
  fi
  chmod +x "$APPIMAGE"
fi

echo "[setup-e2e] Extracting AppImage (no FUSE required) ..."
( cd "$CACHE_DIR" && "$APPIMAGE" --appimage-extract >/dev/null )

if [ ! -x "$BINARY" ]; then
  echo "[setup-e2e] ERROR: expected Electron binary not found at $BINARY" >&2
  exit 1
fi

echo "[setup-e2e] Ready: $BINARY"
