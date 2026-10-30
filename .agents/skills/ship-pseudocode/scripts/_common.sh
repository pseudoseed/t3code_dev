# Shared setup for the PseudoCode ship scripts. Source it, do not run it.

repo_root() {
  git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" rev-parse --show-toplevel
}

# /usr/bin first: Xcode's export step passes rsync flags only Apple's rsync accepts.
# Node 26, the version package.json pins: the build scripts are TypeScript that Node strips types from.
# Cargo: the desktop build compiles a Rust resource monitor; Homebrew's rustup is keg-only.
setup_path() {
  local root="$1" node26 rustup_bin
  node26="$(ls -d "$HOME"/.nvm/versions/node/v26.* 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$node26" ] || node26="$(brew --prefix node@26 2>/dev/null || true)"
  if [ -z "$node26" ] || [ ! -x "$node26/bin/node" ]; then
    echo "Node 26 is required. Install it with: brew install node@26" >&2
    exit 1
  fi
  rustup_bin="$(brew --prefix rustup 2>/dev/null || true)/bin"
  export PATH="/usr/bin:$node26/bin:$rustup_bin:$HOME/.cargo/bin:$root/node_modules/.bin:$PATH"
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

# A release is built from fork main as merged on GitHub, so its tag can point at the exact
# commit that produced the artifact. Anything else is a build of code main does not have.
require_main_head() {
  git fetch --quiet origin main
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "HEAD is not origin/main. Merge the release PR, then build from origin/main:" >&2
    echo "  git switch --detach origin/main" >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Uncommitted changes. A release builds exactly what origin/main holds." >&2
    exit 1
  fi
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
