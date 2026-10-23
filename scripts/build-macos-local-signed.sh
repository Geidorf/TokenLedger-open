#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper is only available on macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY="${TOKENLEDGER_LOCAL_SIGNING_IDENTITY:-TokenLedger Local Code Signing}"
INSTALL=false

if [[ "${1:-}" == "--install" ]]; then
  INSTALL=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--install]" >&2
  exit 2
fi

"$ROOT_DIR/scripts/setup-macos-local-signing.sh"

cd "$ROOT_DIR"
npm run version:check
npx tauri build \
  --debug \
  --bundles app,dmg \
  --ci \
  --config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"$IDENTITY\"}}}"

APP_PATH="$ROOT_DIR/src-tauri/target/debug/bundle/macos/tokenledger.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
if ! codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -F "Authority=$IDENTITY" >/dev/null; then
  echo "Built app does not carry the expected stable signing identity." >&2
  exit 1
fi

echo "Verified signed app: $APP_PATH"

if [[ "$INSTALL" == true ]]; then
  pkill -x tokenledger >/dev/null 2>&1 || true
  sleep 1
  INSTALL_TARGET="/Applications/TokenLedger.app"
  BACKUP_DIR="$HOME/.Trash"
  if [[ -e "$INSTALL_TARGET" ]]; then
    BACKUP_PATH="$BACKUP_DIR/TokenLedger-pre-install-$(date +%Y%m%d-%H%M%S).app"
    mkdir -p "$BACKUP_DIR"
    mv "$INSTALL_TARGET" "$BACKUP_PATH"
    echo "Backed up previous app to $BACKUP_PATH"
  fi
  ditto "$APP_PATH" "$INSTALL_TARGET"
  codesign --verify --deep --strict --verbose=2 "$INSTALL_TARGET"
  INSTALLED_SHA="$(shasum -a 256 "$INSTALL_TARGET/Contents/MacOS/tokenledger" | awk '{print $1}')"
  BUILT_SHA="$(shasum -a 256 "$APP_PATH/Contents/MacOS/tokenledger" | awk '{print $1}')"
  if [[ "$INSTALLED_SHA" != "$BUILT_SHA" ]]; then
    echo "Installed app does not match the verified build." >&2
    exit 1
  fi
  open "$INSTALL_TARGET"
  echo "Installed and opened $INSTALL_TARGET"
fi
