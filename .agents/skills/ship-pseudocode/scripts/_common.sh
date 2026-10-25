# Shared setup for the PseudoCode ship scripts. Source it, do not run it.

repo_root() {
  git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" rev-parse --show-toplevel
}

# /usr/bin first: Xcode's export step passes rsync flags only Apple's rsync accepts.
# Node 26, the version package.json pins: the build scripts are TypeScript that Node strips types from.
setup_path() {
  local root="$1" node26
  node26="$(ls -d "$HOME"/.nvm/versions/node/v26.* 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$node26" ] || node26="$(brew --prefix node@26 2>/dev/null || true)"
  if [ -z "$node26" ] || [ ! -x "$node26/bin/node" ]; then
    echo "Node 26 is required. Install it with: brew install node@26" >&2
    exit 1
  fi
  export PATH="/usr/bin:$node26/bin:$root/node_modules/.bin:$PATH"
}

# Branding and identifiers live in .env.local. The desktop build reads T3CODE_APP_NAME and
# T3CODE_APP_ICON from the environment only, so exporting them here is what makes the fork's
# name and icon reach the artifact.
load_env_local() {
  local root="$1"
  if [ ! -f "$root/.env.local" ]; then
    echo "Missing $root/.env.local. Copy it from another worktree." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  . "$root/.env.local"
  set +a
}

require_vars() {
  local missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing in .env.local: ${missing[*]}" >&2
    exit 1
  fi
}
