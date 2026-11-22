#!/usr/bin/env bash
# Optional: install the Google Antigravity desktop app into the noVNC desktop.
# Run inside the Codespace:  sanda   (then pick "Antigravity Desktop app")
# The CLI is installed from the same menu (command: agy).

set -uo pipefail

log()  { printf '[sanda] %s\n' "$*"; }
warn() { printf '[sanda] WARN: %s\n' "$*" >&2; }

export DEBIAN_FRONTEND=noninteractive
SUDO=()
[ "$(id -u)" -eq 0 ] || SUDO=(sudo)

case "$(uname -m)" in
  x86_64|amd64) AGY_ARCH="linux-x64" ;;
  aarch64|arm64) AGY_ARCH="linux-arm" ;;
  *) warn "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac

log "Resolving the current Antigravity download URL"
PAGE="$(curl -fsSL https://antigravity.google/download || true)"
URL="$(printf '%s' "$PAGE" \
  | grep -oE "https://storage\.googleapis\.com/antigravity-public/antigravity-hub/[^\"']*/${AGY_ARCH}/Antigravity\.tar\.gz" \
  | head -n 1)"

if [ -z "$URL" ]; then
  warn "Could not resolve a download URL."
  warn "Open https://antigravity.google/download in the desktop browser instead."
  exit 1
fi

log "Downloading $URL"
TMP_DIR="$(mktemp -d)"
if ! curl -fL --progress-bar "$URL" -o "$TMP_DIR/Antigravity.tar.gz"; then
  warn "Download failed"
  rm -rf "$TMP_DIR"
  exit 1
fi

log "Installing Electron runtime libraries (best effort)"
"${SUDO[@]}" apt-get install -y -qq --no-install-recommends \
  libgtk-3-0 libnss3 libgbm1 libxss1 libxshmfence1 \
  || warn "Some runtime libraries may be missing"
"${SUDO[@]}" apt-get install -y -qq --no-install-recommends libasound2t64 \
  || "${SUDO[@]}" apt-get install -y -qq --no-install-recommends libasound2 \
  || warn "Could not install libasound2"

DEST="$HOME/.local/opt/antigravity"
rm -rf "$DEST"
mkdir -p "$DEST"

log "Extracting to $DEST"
if ! tar -xzf "$TMP_DIR/Antigravity.tar.gz" -C "$DEST"; then
  warn "Extraction failed"
  rm -rf "$TMP_DIR"
  exit 1
fi
rm -rf "$TMP_DIR"

BIN="$(find "$DEST" -maxdepth 3 -type f -name 'antigravity' -perm -u+x | head -n 1)"
[ -n "$BIN" ] || BIN="$(find "$DEST" -maxdepth 3 -type f -name 'antigravity' | head -n 1)"
if [ -z "$BIN" ]; then
  warn "Installed files do not contain an 'antigravity' launcher; inspect $DEST"
  exit 1
fi
chmod +x "$BIN"

mkdir -p "$HOME/.local/bin"
ln -sf "$BIN" "$HOME/.local/bin/antigravity"

mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/antigravity.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Google Antigravity
Comment=Agent-first IDE
Exec=$BIN --no-sandbox %U
Terminal=false
Categories=Development;
EOF

log "Installed: $BIN"
log "Launch from the XFCE menu, or run 'antigravity --no-sandbox' in a desktop terminal."
