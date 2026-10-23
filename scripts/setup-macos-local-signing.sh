#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper is only available on macOS." >&2
  exit 1
fi

IDENTITY="${TOKENLEDGER_LOCAL_SIGNING_IDENTITY:-TokenLedger Local Code Signing}"
KEYCHAIN="$(security default-keychain -d user | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -Fq "\"$IDENTITY\""; then
  echo "Reusing macOS signing identity: $IDENTITY"
  exit 0
fi

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "A certificate named '$IDENTITY' exists but is not a valid code-signing identity." >&2
  echo "Remove or repair that certificate in Keychain Access before retrying." >&2
  exit 1
fi

OPENSSL_BIN=""
for candidate in /opt/homebrew/bin/openssl /usr/local/bin/openssl /usr/bin/openssl; do
  if [[ -x "$candidate" ]] && "$candidate" version 2>/dev/null | grep -Eq 'OpenSSL ([1-9]|[1-9][0-9])\.'; then
    OPENSSL_BIN="$candidate"
    break
  fi
done
if [[ -z "$OPENSSL_BIN" ]]; then
  echo "OpenSSL 1.1.1 or newer is required to create the local signing identity." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tokenledger-signing.XXXXXX")"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

CERTIFICATE="$TEMP_DIR/tokenledger-local-signing.crt"
PRIVATE_KEY="$TEMP_DIR/tokenledger-local-signing.key"
ARCHIVE="$TEMP_DIR/tokenledger-local-signing.p12"
ARCHIVE_PASSWORD="$($OPENSSL_BIN rand -hex 32)"

"$OPENSSL_BIN" req \
  -x509 \
  -newkey rsa:3072 \
  -sha256 \
  -nodes \
  -days 3650 \
  -subj "/CN=$IDENTITY/O=TokenLedger Local Development/OU=Self Use" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$PRIVATE_KEY" \
  -out "$CERTIFICATE" \
  >/dev/null 2>&1

"$OPENSSL_BIN" pkcs12 \
  -export \
  -legacy \
  -name "$IDENTITY" \
  -inkey "$PRIVATE_KEY" \
  -in "$CERTIFICATE" \
  -out "$ARCHIVE" \
  -passout "pass:$ARCHIVE_PASSWORD" \
  >/dev/null 2>&1

security import "$ARCHIVE" \
  -k "$KEYCHAIN" \
  -P "$ARCHIVE_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  >/dev/null

echo "macOS may request your login password once to trust the TokenLedger local signing identity."
security add-trusted-cert \
  -r trustRoot \
  -p codeSign \
  -k "$KEYCHAIN" \
  "$CERTIFICATE"

if ! security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -Fq "\"$IDENTITY\""; then
  echo "The certificate was imported but is not trusted for code signing." >&2
  echo "Open Keychain Access, trust '$IDENTITY' for Code Signing, then retry." >&2
  exit 1
fi

echo "Created reusable macOS signing identity: $IDENTITY"
echo "Future TokenLedger local builds can reuse it without another trust prompt."
