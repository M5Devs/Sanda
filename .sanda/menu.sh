#!/usr/bin/env bash
# Sanda — install AI coding agents on demand.
#
# Installed as /usr/local/bin/sanda by .sanda/setup.sh. The interactive menu is
# a plain numbered list on purpose: mobile keyboards have no arrow keys, so you
# type numbers instead of navigating a TUI.
#
#   sanda                  numbered menu
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

TOOL_IDS=(dsh opencode pi codex agy agy-desktop)
TOOL_BINS=(dsh opencode pi codex agy antigravity)
TOOL_LABELS=(
  "DeepSeek Harness      (dsh, web UI on :3080)"
  "OpenCode              (opencode-ai)"
  "Pi coding agent       (@earendil-works/pi-coding-agent)"
  "OpenAI Codex CLI      (@openai/codex)"
  "Antigravity CLI       (agy)"
  "Antigravity Desktop   (~210 MB download)"
)

show_menu() {
  local i mark
  printf '\n%s  What do you want to install?\n\n' "$TAG"
  for i in "${!TOOL_IDS[@]}"; do
    mark="  "
    have "${TOOL_BINS[$i]}" && mark="✓ "
    printf '  %s%d) %s\n' "$mark" "$((i + 1))" "${TOOL_LABELS[$i]}"
  done
  printf '\n  a) install all CLI agents\n'
  printf '  s) show installed tools\n'
  printf '  q) quit\n\n'
  printf 'Numbers separated by spaces (e.g. 1 3), or a/s/q: '
}

show_status() {
  local i
  printf '\n%s  Installed tools\n' "$TAG"
  for i in "${!TOOL_IDS[@]}"; do
    if have "${TOOL_BINS[$i]}"; then
      printf '  ✓ %-11s %s\n' "${TOOL_BINS[$i]}" "$(command -v "${TOOL_BINS[$i]}")"
    else
      printf '  · %-11s not installed\n' "${TOOL_BINS[$i]}"
    fi
  done
  printf '\n'
}

run_picks() {
  local input="$1" token
  local -a tokens=() picked=()

  read -r -a tokens <<< "$input"

  for token in "${tokens[@]}"; do
    case "$token" in
      a|A) install_all; log "All CLI agents processed."; return 0 ;;
      s|S) show_status; return 0 ;;
      q|Q) exit 0 ;;
      ''|*[!0-9]*)
        warn "Ignoring '$token' (expected a number, a, s or q)"
        ;;
      *)
        if [ "$token" -ge 1 ] && [ "$token" -le "${#TOOL_IDS[@]}" ]; then
          picked+=("${TOOL_IDS[$((token - 1))]}")
        else
          warn "No tool numbered $token (valid: 1-${#TOOL_IDS[@]})"
        fi
        ;;
    esac
  done

  if [ "${#picked[@]}" -eq 0 ]; then
    return 0
  fi

  install_tags "${picked[@]}"
  log "Done. Run 'agents' to see what is available."
}

interactive() {
  local input
  while true; do
    show_menu
    if ! IFS= read -r input; then
      printf '\n'
      exit 0
    fi
    run_picks "$input"
  done
}

usage() {
  cat <<'EOF'
Usage: sanda [command]

  sanda                 numbered menu (no arrow keys needed)
  sanda --all           install all CLI agents
  sanda --status        list installed tools
  sanda install <tool>  install named tools

Tools: dsh, opencode, pi, codex, agy, agy-desktop

Agents are installed on demand so Codespace creation stays fast.
Prefer a browser? The Sanda dashboard on port 4040 does the same thing.
EOF
}

main() {
  case "${1:-}" in
    ""|-m|--menu)
      if [ ! -t 0 ] || [ ! -t 1 ]; then
        usage
        exit 1
      fi
      interactive
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
