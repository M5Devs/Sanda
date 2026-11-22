#!/usr/bin/env bash
# Sanda — Codespaces provisioning.
#
# Fast by design: only the desktop and base tooling are installed here. AI
# agents are installed on demand with the `sanda` menu, so container creation
# stays quick and you only download what you actually use.

set -uo pipefail

readonly TAG="[sanda]"
log()  { printf '%s %s\n' "$TAG" "$*"; }
warn() { printf '%s WARN: %s\n' "$TAG" "$*" >&2; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export DEBIAN_FRONTEND=noninteractive
export PATH="$HOME/.local/bin:$PATH"

SUDO=()
[ "$(id -u)" -eq 0 ] || SUDO=(sudo)

log "Updating apt package lists"
"${SUDO[@]}" apt-get update -qq || warn "apt-get update failed; continuing with cached lists"

log "Installing base tools: tmux htop jq whiptail ffmpeg ..."
"${SUDO[@]}" apt-get install -y -qq --no-install-recommends \
  tmux htop jq whiptail ffmpeg curl ca-certificates unzip xdg-utils \
  || warn "Some base tools could not be installed"

browser_works() {
  local b
  for b in chromium chromium-browser google-chrome firefox; do
    if command -v "$b" >/dev/null 2>&1 && timeout 20 "$b" --version >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

install_browser() {
  if browser_works; then
    log "A working browser is already installed"
    return 0
  fi

  log "Installing Chromium"
  # Ubuntu ships chromium as a snap stub that passes command -v but cannot run
  # in a container, so require the binary to actually report a version.
  if "${SUDO[@]}" apt-get install -y -qq --no-install-recommends chromium >/dev/null 2>&1 \
     && command -v chromium >/dev/null 2>&1 \
     && timeout 20 chromium --version >/dev/null 2>&1; then
    log "Chromium installed"
    return 0
  fi

  local arch deb
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) warn "No browser package for $(uname -m); skipping"; return 0 ;;
  esac

  deb="/tmp/google-chrome-stable_${arch}.deb"
  log "Chromium unavailable via apt; installing Google Chrome ($arch)"
  if curl -fsSL "https://dl.google.com/linux/direct/google-chrome-stable_current_${arch}.deb" -o "$deb" \
     && "${SUDO[@]}" apt-get install -y -qq "$deb" >/dev/null 2>&1; then
    log "Google Chrome installed"
  else
    warn "Browser install failed; the desktop still works without one"
  fi
  rm -f "$deb"
}

install_browser

# desktop-lite ships only Fluxbox; upgrade the session to XFCE for a usable
# panel and application menu on a phone screen.
configure_desktop() {
  if ! command -v startxfce4 >/dev/null 2>&1; then
    log "Installing XFCE desktop"
    if ! "${SUDO[@]}" apt-get install -y -qq --no-install-recommends \
         xfce4 xfce4-terminal dbus-x11; then
      warn "XFCE install failed; keeping the default Fluxbox session"
      return 0
    fi
  fi

  # TigerVNC starts ~/.vnc/xstartup; this replaces the Fluxbox session.
  mkdir -p "$HOME/.vnc" 2>/dev/null || true
  if [ -d "$HOME/.vnc" ] && [ -w "$HOME/.vnc" ]; then
    cat > "$HOME/.vnc/xstartup" <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF
    chmod +x "$HOME/.vnc/xstartup"
  fi

  "${SUDO[@]}" update-alternatives --set x-session-manager /usr/bin/xfce4-session \
    >/dev/null 2>&1 || true

  # The VNC session may already be up with Fluxbox. Its watchdog restarts
  # Xtigervnc within a few seconds and then picks up the new xstartup.
  if pgrep -x Xtigervnc >/dev/null 2>&1; then
    log "Restarting the VNC session so it loads XFCE"
    "${SUDO[@]}" pkill -f "Xtigervnc ${DISPLAY:-:1}" >/dev/null 2>&1 || true
  fi
}

configure_desktop

# Register the on-demand installer as `sanda`.
if [ -f "$SCRIPT_DIR/menu.sh" ]; then
  chmod +x "$SCRIPT_DIR/menu.sh" 2>/dev/null || true
  if "${SUDO[@]}" ln -sf "$SCRIPT_DIR/menu.sh" /usr/local/bin/sanda; then
    log "Installed the 'sanda' command"
  else
    warn "Could not install /usr/local/bin/sanda"
  fi
else
  warn "menu.sh is missing; the 'sanda' command was not installed"
fi

if ! command -v npm >/dev/null 2>&1; then
  warn "npm not found; 'sanda' will not be able to install Node-based agents"
fi

BASHRC="$HOME/.bashrc"
touch "$BASHRC" 2>/dev/null || true

if [ -f "$BASHRC" ] && ! grep -qF '# >>> Sanda >>>' "$BASHRC"; then
  cat >> "$BASHRC" <<'SANDA_BASHRC'

# >>> Sanda >>>
export PATH="$HOME/.local/bin:$PATH"

# DeepSeek Harness web UI on forwarded port 3080. In Codespaces the browser
# reaches the app through a proxy, so tell dsh to trust the forwarded host.
dsh-web() {
  local extra=()
  if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
    extra+=(--trusted-host "${CODESPACE_NAME}-3080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}")
  fi
  npx -y @deepseek-ai/dsh web --port 3080 --no-open "${extra[@]}"
}

alias dsh-tui='npx -y @deepseek-ai/dsh tui'
alias antigravity-desktop='bash "@SCRIPT_DIR@/antigravity-desktop.sh"'

agents() {
  local a
  for a in dsh opencode pi codex agy; do
    if command -v "$a" >/dev/null 2>&1; then
      printf '  %-9s %s\n' "$a" "$(command -v "$a")"
    else
      printf '  %-9s (not installed)\n' "$a"
    fi
  done
}

if [ -t 1 ]; then
  printf '\n\033[1;36mSanda\033[0m — run \033[1msanda\033[0m to pick and install your AI coding tools.\n\n'
fi
# <<< Sanda <<<
SANDA_BASHRC
  sed -i "s|@SCRIPT_DIR@|${SCRIPT_DIR}|g" "$BASHRC"
fi

log "Base setup complete."
log "Desktop: port 6080 (noVNC). Run 'sanda' to install your AI coding tools."
log "Stop the Codespace when you are finished to save your free monthly hours."
