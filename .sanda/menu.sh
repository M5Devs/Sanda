#!/usr/bin/env bash
# Sanda — install AI coding agents on demand.
#
# Installed as /usr/local/bin/sanda by .sanda/setup.sh.
#   sanda                  interactive checklist
#   sanda install dsh pi   install named tools
#   sanda --all            install every CLI agent
#   sanda --status         list what is installed

set -uo pipefail

readonly TAG="[sanda]"
log()  { printf '%s %s\n' "$TAG" "$*"; }
warn() { printf '%s WARN: %s\n' "$TAG" "$*" >&2; }

SANDA_DIR="$(cd -- "$(dirname -- "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
readonly SANDA_DIR
export PATH="$HOME/.local/bin:$PATH"
[ -n "${TERM:-}" ] || export TERM=xterm

NPM=(npm)
have() { command -v "$1" >/dev/null 2>&1; }

init_npm() {
  if ! have npm; then
    warn "npm not found. Restart the Codespace; the Node feature provides it."
    return 1
  fi
  local npm_bin npm_prefix
  npm_bin="$(command -v npm)"
  NPM=("$npm_bin")
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  # sudo resets PATH, so pass the absolute path (nvm's npm is not in root's PATH).
  if [ -n "$npm_prefix" ] && [ ! -w "$npm_prefix" ]; then
    NPM=(sudo "$npm_bin")
  fi
  return 0
}

npm_agent() {
  local pkg="$1" bin="$2" label="$3"
  if have "$bin"; then
    log "$label is already installed ($bin)"
    return 0
  fi
  init_npm || return 1
  log "Installing $label ($pkg)"
  if "${NPM[@]}" install -g --no-fund --no-audit "$pkg" >/tmp/sanda-npm-install.log 2>&1; then
    if have "$bin"; then
      log "$label installed"
      return 0
    fi
    warn "$pkg installed, but '$bin' is not on PATH yet"
    return 1
  fi
  warn "Installing $pkg failed (see /tmp/sanda-npm-install.log)"
  return 1
}

install_dsh()      { npm_agent "@deepseek-ai/dsh" dsh "DeepSeek Harness"; }
install_opencode() { npm_agent "opencode-ai" opencode "OpenCode"; }
install_pi()       { npm_agent "@earendil-works/pi-coding-agent" pi "Pi coding agent"; }
install_codex()    { npm_agent "@openai/codex" codex "OpenAI Codex CLI"; }

install_agy() {
  if have agy; then
    log "Antigravity CLI is already installed (agy)"
    return 0
  fi

  log "Installing Google Antigravity CLI"
  local tmp
  tmp="$(mktemp)"
  if ! curl -fsSL https://antigravity.google/cli/install.sh -o "$tmp"; then
    warn "Could not download the Antigravity installer"
    rm -f "$tmp"
    return 1
  fi
  # Inspect before running: only execute something that is a shell script.
  if head -n 1 "$tmp" | grep -qE '^#!.*sh'; then
    if ! bash "$tmp"; then
      warn "Antigravity CLI installer failed"
      rm -f "$tmp"
      return 1
    fi
  else
    warn "Antigravity installer was not a shell script; skipping"
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"

  if have agy; then
    log "Antigravity CLI installed (agy)"
    return 0
  fi
  warn "agy was not found after install; open a new shell and try 'agy'"
  return 1
}

install_agy_desktop() {
  if [ ! -f "$SANDA_DIR/antigravity-desktop.sh" ]; then
    warn "antigravity-desktop.sh is missing from $SANDA_DIR"
    return 1
  fi
  bash "$SANDA_DIR/antigravity-desktop.sh"
}

install_all() {
  install_dsh || true
  install_opencode || true
  install_pi || true
  install_codex || true
  install_agy || true
}

install_tags() {
  local tag
  for tag in "$@"; do
    case "$tag" in
      dsh)         install_dsh || true ;;
      opencode)    install_opencode || true ;;
      pi)          install_pi || true ;;
      codex)       install_codex || true ;;
      agy)         install_agy || true ;;
      agy-desktop) install_agy_desktop || true ;;
      *)           warn "Unknown tool: $tag" ;;
    esac
  done
}

CHECKLIST_ITEMS=(
  "dsh"         "DeepSeek Harness   (dsh, web UI on :3080)"     OFF
  "opencode"    "OpenCode           (opencode-ai)"              OFF
  "pi"          "Pi coding agent    (@earendil-works/pi-coding-agent)" OFF
  "codex"       "OpenAI Codex CLI   (@openai/codex)"            OFF
  "agy"         "Antigravity CLI    (agy)"                      OFF
  "agy-desktop" "Antigravity Desktop app  (~210 MB download)"   OFF
)

require_whiptail() {
  if ! have whiptail; then
    warn "whiptail is not installed. Run: sudo apt-get install -y whiptail"
    return 1
  fi
}

main_menu() {
  whiptail --title "Sanda" --menu "Install AI coding tools on demand" 16 78 6 \
    "pick"   "Pick and install tools (checklist)" \
    "all"    "Install all CLI agents" \
    "status" "Show installed tools" \
    "quit"   "Exit" \
    3>&1 1>&2 2>&3
}

pick_tools() {
  local choices tags
  if ! choices="$(whiptail --title "Sanda — pick your tools" \
      --checklist "Space toggles a tool, Enter installs the selected ones." \
      20 86 8 "${CHECKLIST_ITEMS[@]}" 3>&1 1>&2 2>&3)"; then
    return 0
  fi

  choices="$(printf '%s' "$choices" | tr -d '"')"
  if [ -z "$choices" ]; then
    log "Nothing selected."
    return 0
  fi

  read -r -a tags <<< "$choices"
  install_tags "${tags[@]}"
  log "Done. Run 'agents' to see what is available."
}

show_status() {
  local a rows=""
  for a in dsh opencode pi codex agy; do
    if have "$a"; then
      rows+="$a: $(command -v "$a")"$'\n'
    else
      rows+="$a: not installed"$'\n'
    fi
  done

  if [ -t 1 ] && have whiptail; then
    whiptail --title "Sanda — installed tools" --msgbox "$rows" 16 78 3>&1 1>&2 2>&3 || true
  else
    printf '%s' "$rows"
  fi
}

usage() {
  cat <<'EOF'
Usage: sanda [command]

  sanda                 interactive menu (pick tools, install all, status)
  sanda --all           install all CLI agents
  sanda --status        list installed tools
  sanda install <tool>  install named tools

Tools: dsh, opencode, pi, codex, agy, agy-desktop

Agents are installed on demand so Codespace creation stays fast.
EOF
}

main() {
  case "${1:-}" in
    ""|-m|--menu)
      if [ ! -t 0 ] || [ ! -t 1 ]; then
        usage
        exit 1
      fi
      require_whiptail || exit 1
      while true; do
        local action
        if ! action="$(main_menu)"; then
          exit 0
        fi
        case "$action" in
          pick)   pick_tools ;;
          all)    install_all; log "All CLI agents processed." ;;
          status) show_status ;;
          quit)   exit 0 ;;
        esac
      done
      ;;
    --all|all)
      install_all
      log "All CLI agents processed."
      ;;
    --status|status)
      show_status
      ;;
    install|--install)
      shift
      if [ "$#" -eq 0 ]; then
        usage
        exit 1
      fi
      install_tags "$@"
      log "Done. Run 'agents' to see what is available."
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
