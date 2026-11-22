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
REPO_DIR="$(dirname -- "$SCRIPT_DIR")"
export DEBIAN_FRONTEND=noninteractive
export PATH="$HOME/.local/bin:$PATH"

SUDO=()
[ "$(id -u)" -eq 0 ] || SUDO=(sudo)

log "Updating apt package lists"
"${SUDO[@]}" apt-get update -qq || warn "apt-get update failed; continuing with cached lists"

log "Installing base tools: tmux htop jq ffmpeg ..."
"${SUDO[@]}" apt-get install -y -qq --no-install-recommends \
  tmux htop jq ffmpeg curl ca-certificates unzip xdg-utils \
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

# Dark theme and a readable terminal font. Written as config files so they also
# apply when the session is not running yet; xfconf-query applies them live when
# a session is reachable.
configure_desktop_look() {
  local cfg="$HOME/.config/xfce4"
  mkdir -p "$cfg/xfconf/xfce-perchannel-xml" "$cfg/terminal" 2>/dev/null || return 0

  local wm_theme="Default" t
  for t in Greybird-dark Adwaita-dark; do
    if [ -d "/usr/share/themes/$t/xfwm4" ]; then
      wm_theme="$t"
      break
    fi
  done

  cat > "$cfg/xfconf/xfce-perchannel-xml/xsettings.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Adwaita-dark"/>
    <property name="IconThemeName" type="string" value="Adwaita"/>
  </property>
  <property name="Xft" type="empty">
    <property name="DPI" type="int" value="96"/>
    <property name="Antialias" type="int" value="1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="rgb"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="FontName" type="string" value="Sans 11"/>
  </property>
</channel>
EOF

  cat > "$cfg/xfconf/xfce-perchannel-xml/xfwm4.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="$wm_theme"/>
    <property name="title_font" type="string" value="Sans Bold 10"/>
    <property name="title_alignment" type="string" value="center"/>
  </property>
</channel>
EOF

  cat > "$cfg/terminal/terminalrc" <<'EOF'
[Configuration]
FontName=Monospace 13
FontUseSystem=FALSE
ColorForeground=#e8ebf2
ColorBackground=#141821
ColorCursor=#7c5cff
ColorBold=#ffffff
MiscDefaultGeometry=120x34
MiscMouseWheelZoom=TRUE
MiscAlwaysShowTabs=FALSE
MiscSlimTabs=FALSE
EOF

  if command -v xfconf-query >/dev/null 2>&1; then
    xfconf-query -c xsettings -p /Net/ThemeName -s Adwaita-dark >/dev/null 2>&1 || true
    xfconf-query -c xfwm4 -p /general/theme -s "$wm_theme" >/dev/null 2>&1 || true
  fi
}

write_launcher() {
  local dir="$1" file="$2" name="$3" comment="$4" exec_line="$5" icon="$6"
  cat > "$dir/$file" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$name
Comment=$comment
Exec=$exec_line
Icon=$icon
Terminal=false
Categories=Development;Utility;
EOF
  chmod +x "$dir/$file"
}

# Populate ~/Desktop so a fresh XFCE session is not an empty screen.
create_desktop_shortcuts() {
  local desktop bin="$HOME/.local/bin"
  desktop="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  [ -n "$desktop" ] || desktop="$HOME/Desktop"
  mkdir -p "$desktop" "$bin" 2>/dev/null || return 0

  cat > "$bin/sanda-open-dashboard" <<'EOF'
#!/usr/bin/env bash
url="http://localhost:${SANDA_WEB_PORT:-4040}"
for opener in xdg-open exo-open; do
  if command -v "$opener" >/dev/null 2>&1 && "$opener" "$url" >/dev/null 2>&1; then
    exit 0
  fi
done
for browser in google-chrome google-chrome-stable chromium chromium-browser firefox; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" --no-sandbox "$url"
  fi
done
printf 'No browser found\n' >&2
exit 1
EOF

  cat > "$bin/sanda-open-browser" <<'EOF'
#!/usr/bin/env bash
for browser in google-chrome google-chrome-stable chromium chromium-browser firefox; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" --no-sandbox "$@"
  fi
done
printf 'No browser found\n' >&2
exit 1
EOF

  cat > "$bin/sanda-open-workspace" <<'EOF'
#!/usr/bin/env bash
dir="@REPO_DIR@"
if command -v thunar >/dev/null 2>&1; then
  exec thunar "$dir"
fi
if command -v xfce4-terminal >/dev/null 2>&1; then
  exec xfce4-terminal --working-directory="$dir" --maximize
fi
exec x-terminal-emulator
EOF

  sed -i "s|@REPO_DIR@|$REPO_DIR|g" "$bin/sanda-open-workspace"
  chmod +x "$bin/sanda-open-dashboard" "$bin/sanda-open-browser" "$bin/sanda-open-workspace"

  local chrome="" b
  for b in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$b" >/dev/null 2>&1; then
      chrome="$b"
      break
    fi
  done

  write_launcher "$desktop" "sanda-dashboard.desktop" "Sanda Dashboard" \
    "Control center for your AI coding tools" "$bin/sanda-open-dashboard" "web-browser"
  write_launcher "$desktop" "sanda-terminal.desktop" "Sanda Terminal" \
    "Full-size terminal" "xfce4-terminal --maximize" "utilities-terminal"
  write_launcher "$desktop" "sanda-workspace.desktop" "Workspace" \
    "Open the project folder" "$bin/sanda-open-workspace" "folder"

  if [ -n "$chrome" ]; then
    write_launcher "$desktop" "google-chrome.desktop" "Google Chrome" \
      "Web browser" "$bin/sanda-open-browser" "google-chrome"
  else
    write_launcher "$desktop" "sanda-browser.desktop" "Web Browser" \
      "Web browser" "$bin/sanda-open-browser" "web-browser"
  fi
}

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

  configure_desktop_look
  create_desktop_shortcuts

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
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"

alias sanda-web='sanda web'
alias sanda-dashboard='sanda web'

# DeepSeek Harness web UI on forwarded port 3080. In Codespaces the browser
# reaches the app through a proxy, so tell dsh to trust the forwarded host.
dsh-web() {
  local extra=()
  if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
    extra+=(--trusted-host "${CODESPACE_NAME}-3080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}")
  fi
  # Tee the banner: the dashboard reads the ?token= it prints, so a dsh started
  # here still gets a working Open link on port 4040.
  npx -y @deepseek-ai/dsh web --port 3080 --no-open "${extra[@]}" 2>&1 \
    | tee -a /tmp/sanda-dsh-web.log
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
  printf '\n\033[1;36mSanda\033[0m — dashboard: http://localhost:4040 · run \033[1msanda\033[0m to install tools.\n\n'
fi
# <<< Sanda <<<
SANDA_BASHRC
  sed -i "s|@SCRIPT_DIR@|${SCRIPT_DIR}|g" "$BASHRC"
fi

log "Base setup complete."
log "Dashboard: port 4040 · Desktop: port 6080 (noVNC) · DeepSeek web UI: port 3080"
log "Run 'sanda' or open the dashboard to install your AI coding tools."
log "Stop the Codespace when you are finished to save your free monthly hours."
