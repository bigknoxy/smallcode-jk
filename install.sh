#!/bin/sh
set -eu

# smallcode installer — idempotent, POSIX sh
# Usage: curl -fsSL https://raw.githubusercontent.com/bigknoxy/smallcode-jk/main/install.sh | sh
# Env overrides:
#   SMALLCODE_HOME      — installation directory   (default: ~/.smallcode)
#   SMALLCODE_BIN_DIR   — wrapper binary directory (default: ~/.local/bin)
#   SMALLCODE_TARBALL   — local path or URL to tarball; skips GitHub release query

REPO="bigknoxy/smallcode-jk"
INSTALL_DIR="${SMALLCODE_HOME:-$HOME/.smallcode}"
BIN_DIR="${SMALLCODE_BIN_DIR:-$HOME/.local/bin}"

# ── helpers ──────────────────────────────────────────────────────────────────
log()  { printf '[smallcode] %s\n' "$*" >&2; }
warn() { printf '[smallcode] WARNING: %s\n' "$*" >&2; }
err()  { printf '[smallcode] ERROR: %s\n' "$*" >&2; exit 1; }

# The recommended default model (matches `smallcode config init`).
DEFAULT_MODEL="qwen2.5-coder:3b"

# ── consent (E2-T5) ───────────────────────────────────────────────────────────
# Network/OS actions (installing bun/ollama, pulling a multi-GB model) are gated
# behind a y/N prompt on an interactive TTY. A piped `curl | sh` install has no
# TTY and proceeds automatically; `--yes`/`-y`/`SMALLCODE_YES=1` forces auto too.
ASSUME_YES=0
for _arg in "$@"; do
  case "$_arg" in
    -y|--yes) ASSUME_YES=1 ;;
  esac
done
[ "${SMALLCODE_YES:-0}" = "1" ] && ASSUME_YES=1

# confirm "<question>" → 0 (yes) / 1 (no). Auto-yes when --yes or non-interactive.
confirm() {
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    return 0
  fi
  printf '[smallcode] %s [y/N] ' "$1" >&2
  read -r _reply </dev/tty 2>/dev/null || return 1
  case "$_reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ── ensure bun ────────────────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  warn "bun (JavaScript runtime) is required and was not found on PATH."
  if confirm "Install bun now from https://bun.sh?"; then
    log "Installing bun…"
    curl -fsSL https://bun.sh/install | bash || err "bun install failed — install it manually from https://bun.sh and re-run."
    # bun installs to ~/.bun/bin; make it visible for the rest of this script.
    [ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 || err "bun still not on PATH after install. Add ~/.bun/bin to PATH and re-run."
  else
    err "bun is required. Install it: curl -fsSL https://bun.sh/install | bash — then re-run this installer."
  fi
fi

BUN_BIN="$(command -v bun)"
log "Using bun: $BUN_BIN ($(bun --version))"

# ── ensure ollama ─────────────────────────────────────────────────────────────
if ! command -v ollama >/dev/null 2>&1; then
  warn "ollama (local model server) not found. smallcode needs it to serve models."
  if confirm "Install Ollama now?"; then
    if [ "$(uname -s)" = "Linux" ]; then
      log "Installing Ollama (official installer)…"
      curl -fsSL https://ollama.com/install.sh | sh || warn "Ollama install failed — install it manually from https://ollama.com/download."
    else
      # macOS/other: the official installer is a GUI .app; point the user at it.
      warn "On macOS, install the Ollama app from https://ollama.com/download (or 'brew install ollama'), then re-run."
    fi
  else
    warn "Skipping Ollama. Install it later from https://ollama.com/download — 'smallcode doctor' will remind you."
  fi
fi

# ── resolve tarball URL ───────────────────────────────────────────────────────
resolve_tarball_url() {
  if [ -n "${SMALLCODE_TARBALL:-}" ]; then
    printf '%s' "$SMALLCODE_TARBALL"
    return 0
  fi

  # Try to get the latest release tag from GitHub API
  LATEST_TAG=""
  if command -v curl >/dev/null 2>&1; then
    LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' \
      | head -1 \
      | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')" || true
  elif command -v wget >/dev/null 2>&1; then
    LATEST_TAG="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' \
      | head -1 \
      | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')" || true
  fi

  if [ -n "$LATEST_TAG" ]; then
    log "Found latest release: $LATEST_TAG"
    printf 'https://github.com/%s/archive/refs/tags/%s.tar.gz' "$REPO" "$LATEST_TAG"
  else
    log "No release found — falling back to main branch"
    printf 'https://github.com/%s/archive/refs/heads/main.tar.gz' "$REPO"
  fi
}

# ── download tarball ──────────────────────────────────────────────────────────
download_tarball() {
  url="$1"
  dest="$2"

  # If it's a local file path (not http/https), just use it directly
  case "$url" in
    http://*|https://*)
      log "Downloading: $url"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$dest"
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$dest" "$url"
      else
        err "Neither curl nor wget found. Cannot download tarball."
      fi
      ;;
    *)
      # local file
      if [ ! -f "$url" ]; then
        err "SMALLCODE_TARBALL path does not exist: $url"
      fi
      log "Using local tarball: $url"
      cp "$url" "$dest"
      ;;
  esac
}

# ── resolve installed version ────────────────────────────────────────────────
get_installed_version() {
  pkg="$1/package.json"
  if [ -f "$pkg" ]; then
    grep '"version"' "$pkg" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'
  else
    printf 'none'
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

OLD_VERSION="$(get_installed_version "$INSTALL_DIR")"

TARBALL_SOURCE="$(resolve_tarball_url)"

# Create a temp dir for the download
TMP_EXTRACT="$(mktemp -d)"
TMP_TGZ="$TMP_EXTRACT/source.tar.gz"

trap 'rm -rf "$TMP_EXTRACT"' EXIT

download_tarball "$TARBALL_SOURCE" "$TMP_TGZ"

# ── clean & recreate INSTALL_DIR ─────────────────────────────────────────────
log "Installing to: $INSTALL_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Extract, stripping the top-level wrapper directory
tar -xzf "$TMP_TGZ" -C "$TMP_EXTRACT" --strip-components=1

# Move everything (including hidden files) from extract root to INSTALL_DIR
find "$TMP_EXTRACT" -mindepth 1 -maxdepth 1 ! -name 'source.tar.gz' -exec mv {} "$INSTALL_DIR/" \;

# ── bun install ──────────────────────────────────────────────────────────────
log "Running bun install..."
(cd "$INSTALL_DIR" && bun install --frozen-lockfile 2>/dev/null) || \
  (cd "$INSTALL_DIR" && bun install)

# ── write wrapper ────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"

WRAPPER="$BIN_DIR/smallcode"
# Expand INSTALL_DIR at install time (not at wrapper runtime)
cat > "$WRAPPER" <<WRAPPER_EOF
#!/bin/sh
exec bun "${INSTALL_DIR}/bin/smallcode.ts" "\$@"
WRAPPER_EOF
chmod +x "$WRAPPER"

log "Wrapper written: $WRAPPER"

# ── PATH hint ────────────────────────────────────────────────────────────────
case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    ;;
  *)
    log ""
    log "  $BIN_DIR is not on your PATH."
    log "  Add it by appending this to your shell config (~/.bashrc, ~/.zshrc, etc.):"
    log ""
    log "    export PATH=\"$BIN_DIR:\$PATH\""
    log ""
    ;;
esac

# ── offer to pull the default model (E2-T5) ───────────────────────────────────
# Only when Ollama is present and the model isn't already installed.
if command -v ollama >/dev/null 2>&1; then
  if ollama list 2>/dev/null | grep -q "$DEFAULT_MODEL"; then
    log "Model $DEFAULT_MODEL already installed."
  elif confirm "Pull the recommended model $DEFAULT_MODEL now (this downloads ~2 GB)?"; then
    log "Pulling $DEFAULT_MODEL…"
    ollama pull "$DEFAULT_MODEL" || warn "Model pull failed — run 'ollama pull $DEFAULT_MODEL' later."
  else
    log "Skipping model pull. Get it later: ollama pull $DEFAULT_MODEL (or the first run will offer)."
  fi
fi

# ── success ──────────────────────────────────────────────────────────────────
NEW_VERSION="$(get_installed_version "$INSTALL_DIR")"
log ""
log "  smallcode installed successfully!"
log "  Version: $NEW_VERSION  (was: $OLD_VERSION)"

# ── final diagnosis (E2-T5) ───────────────────────────────────────────────────
# End on `smallcode doctor` so the user sees exactly what (if anything) is left
# to do. Non-fatal: doctor exits non-zero if a P0 check fails, but the install
# itself already succeeded, so don't propagate that.
log ""
log "  Running 'smallcode doctor' to verify your setup…"
log ""
"$BUN_BIN" "${INSTALL_DIR}/bin/smallcode.ts" doctor || true
log ""
log "  Next: cd into a project, then 'smallcode config init && smallcode fix'."
log ""
