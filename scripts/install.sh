#!/usr/bin/env bash
#
# Appstrate installer — get.appstrate.dev
#
#   curl -fsSL https://get.appstrate.dev | sh
#
# Env overrides:
#   APPSTRATE_VERSION       Pin a version (default: bundled stable)
#   APPSTRATE_DIR           Install dir (default: $HOME/.appstrate)
#   APPSTRATE_PORT          HTTP port (default: 3000, auto-fallback if busy)

set -euo pipefail

# ─── Constants (APPSTRATE_VERSION rewritten by publish-installer.yml) ─────────
APPSTRATE_VERSION="${APPSTRATE_VERSION:-__APPSTRATE_VERSION__}"
# Docker image tags are published without the 'v' prefix (semver pattern in
# release workflow), but git refs / asset URLs use 'v'. Keep both forms.
APPSTRATE_GIT_REF="$APPSTRATE_VERSION"
APPSTRATE_IMAGE_TAG="${APPSTRATE_VERSION#v}"
# Local testing: copy assets from this dir instead of curl. When unset, fetch from GitHub.
APPSTRATE_ASSETS_DIR="${APPSTRATE_ASSETS_DIR:-}"
APPSTRATE_DIR="${APPSTRATE_DIR:-$HOME/.appstrate}"
APPSTRATE_PORT="${APPSTRATE_PORT:-3000}"
# When 1, suppress the banner and the "Next steps" trailer (used by test harness).
APPSTRATE_QUIET="${APPSTRATE_QUIET:-0}"

GITHUB_REPO="appstrate/appstrate"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_REPO}"
COMPOSE_PATH="examples/self-hosting/docker-compose.yml"
ENV_EXAMPLE_PATH="examples/self-hosting/.env.example"

MIN_DOCKER_MAJOR=20

INSTALL_START=$(date +%s)
LOG_FILE=""
INSTALL_MODE=""
PREVIOUS_VERSION=""

# ─── Output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET="\033[0m"
  C_DIM="\033[2m"
  C_RED="\033[0;31m"
  C_GREEN="\033[0;32m"
  C_YELLOW="\033[0;33m"
  C_CYAN="\033[0;36m"
  C_BOLD="\033[1m"
else
  C_RESET=""
  C_DIM=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_CYAN=""
  C_BOLD=""
fi

log() { printf "%b→%b %s\n" "$C_CYAN" "$C_RESET" "$*"; }
ok() { printf "%b✓%b %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%b⚠%b %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
err() { printf "%b✗%b %s\n" "$C_RED" "$C_RESET" "$*" >&2; }
fatal() {
  err "$*"
  exit 1
}

on_error() {
  local line=$1
  err "Installation failed at line $line"
  [ -n "$LOG_FILE" ] && err "Logs: $LOG_FILE"
  err "Help: https://appstrate.dev/docs/install#troubleshooting"
  err "      https://github.com/${GITHUB_REPO}/issues"
  exit 1
}
trap 'on_error $LINENO' ERR

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ─── Sections ─────────────────────────────────────────────────────────────────

print_banner() {
  cat <<'EOF'

   █████╗ ██████╗ ██████╗ ███████╗████████╗██████╗  █████╗ ████████╗███████╗
  ██╔══██╗██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██╔════╝
  ███████║██████╔╝██████╔╝███████╗   ██║   ██████╔╝███████║   ██║   █████╗
  ██╔══██║██╔═══╝ ██╔═══╝ ╚════██║   ██║   ██╔══██╗██╔══██║   ██║   ██╔══╝
  ██║  ██║██║     ██║     ███████║   ██║   ██║  ██║██║  ██║   ██║   ███████╗
  ╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝

EOF
  printf "%bInstalling Appstrate %s into %s%b\n\n" "$C_BOLD" "$APPSTRATE_VERSION" "$APPSTRATE_DIR" "$C_RESET"
}

detect_environment() {
  log "Checking environment"

  # OS
  local os arch
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$arch" in
    x86_64 | amd64) arch="amd64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) fatal "Unsupported architecture: $arch (need amd64 or arm64)" ;;
  esac
  ok "$os $arch detected"

  # Docker
  if ! command_exists docker; then
    err "Docker is not installed"
    case "$os" in
      Linux) err "Install: curl -fsSL https://get.docker.com | sh" ;;
      Darwin) err "Install Docker Desktop, OrbStack, or Colima" ;;
      *) err "Install Docker for your platform: https://docs.docker.com/get-docker/" ;;
    esac
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    err "Docker is installed but not accessible"
    err "  → Is the daemon running? (Docker Desktop, OrbStack, or 'systemctl start docker')"
    err "  → Are you in the docker group? ('sudo usermod -aG docker \$USER' then re-login)"
    exit 1
  fi

  local docker_version major
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0")
  major=$(echo "$docker_version" | cut -d. -f1)
  if [ "$major" -lt "$MIN_DOCKER_MAJOR" ] 2>/dev/null; then
    fatal "Docker $docker_version detected, need $MIN_DOCKER_MAJOR.10 or higher"
  fi
  ok "Docker $docker_version detected"

  # Compose v2 plugin
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 plugin not found"
    err "  → Update Docker, or install: https://docs.docker.com/compose/install/"
    exit 1
  fi
  local compose_version
  compose_version=$(docker compose version --short 2>/dev/null || echo "?")
  ok "docker compose v$compose_version detected"

  # curl + openssl
  command_exists curl || fatal "curl not found"
  command_exists openssl || fatal "openssl not found"

  # Port (auto-fallback in non-interactive mode = always for piped install)
  if port_in_use "$APPSTRATE_PORT"; then
    local original=$APPSTRATE_PORT
    for p in 3001 3002 3003 3010 8080; do
      if ! port_in_use "$p"; then
        APPSTRATE_PORT=$p
        break
      fi
    done
    if [ "$APPSTRATE_PORT" = "$original" ]; then
      fatal "Port $original is busy and no fallback port available. Set APPSTRATE_PORT=<n>."
    fi
    warn "Port $original busy → using $APPSTRATE_PORT instead"
  else
    ok "Port $APPSTRATE_PORT available"
  fi
}

port_in_use() {
  local p=$1
  if command_exists lsof; then
    lsof -iTCP:"$p" -sTCP:LISTEN -Pn >/dev/null 2>&1
  elif command_exists ss; then
    ss -lnt "sport = :$p" 2>/dev/null | grep -q LISTEN
  elif command_exists nc; then
    nc -z 127.0.0.1 "$p" >/dev/null 2>&1
  else
    return 1
  fi
}

prepare_workdir() {
  mkdir -p "$APPSTRATE_DIR"
  LOG_FILE="$APPSTRATE_DIR/install-$(date +%Y%m%d-%H%M%S).log"
  : >"$LOG_FILE"
  log "Working directory: $APPSTRATE_DIR"
}

determine_install_mode() {
  if [ ! -f "$APPSTRATE_DIR/.env" ]; then
    INSTALL_MODE="fresh"
    return
  fi
  if [ -f "$APPSTRATE_DIR/.version" ]; then
    PREVIOUS_VERSION=$(cat "$APPSTRATE_DIR/.version" 2>/dev/null || echo "")
  fi
  if [ "$PREVIOUS_VERSION" = "$APPSTRATE_VERSION" ]; then
    INSTALL_MODE="noop"
  else
    INSTALL_MODE="upgrade"
  fi
}

download_assets() {
  local tmpdir
  tmpdir="$APPSTRATE_DIR/.tmp"
  rm -rf "$tmpdir"
  mkdir -p "$tmpdir"

  if [ -n "$APPSTRATE_ASSETS_DIR" ]; then
    log "Copying assets from $APPSTRATE_ASSETS_DIR (local mode)"
    cp "$APPSTRATE_ASSETS_DIR/docker-compose.yml" "$tmpdir/docker-compose.yml"
    cp "$APPSTRATE_ASSETS_DIR/.env.example" "$tmpdir/.env.example"
  else
    log "Downloading docker-compose.yml ($APPSTRATE_VERSION)"
    curl_fetch "$GITHUB_RAW/$APPSTRATE_GIT_REF/$COMPOSE_PATH" "$tmpdir/docker-compose.yml"
    curl_fetch "$GITHUB_RAW/$APPSTRATE_GIT_REF/$ENV_EXAMPLE_PATH" "$tmpdir/.env.example"
  fi

  # Backup existing compose on upgrade
  if [ "$INSTALL_MODE" = "upgrade" ] && [ -f "$APPSTRATE_DIR/docker-compose.yml" ]; then
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    cp "$APPSTRATE_DIR/docker-compose.yml" "$APPSTRATE_DIR/docker-compose.yml.bak-$ts"
  fi
  mv "$tmpdir/docker-compose.yml" "$APPSTRATE_DIR/docker-compose.yml"
  mv "$tmpdir/.env.example" "$APPSTRATE_DIR/.env.example"
  rmdir "$tmpdir" 2>/dev/null || true
}

curl_fetch() {
  local url=$1 out=$2
  if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 30 -o "$out" "$url"; then
    fatal "Failed to download $url"
  fi
}

handle_env_file() {
  case "$INSTALL_MODE" in
    fresh)
      log "Generating .env with fresh secrets"
      generate_fresh_env
      ;;
    upgrade)
      log "Merging new .env keys (preserving existing values)"
      merge_env
      local ts
      ts=$(date +%Y%m%d-%H%M%S)
      cp "$APPSTRATE_DIR/.env" "$APPSTRATE_DIR/.env.bak-$ts"
      ;;
    noop) : ;;
  esac
}

generate_fresh_env() {
  local pg auth runtok enckey miniopw uploadsig docker_gid
  pg=$(rand_hex 16)
  auth=$(rand_hex 32)
  runtok=$(rand_hex 32)
  enckey=$(rand_b64 32)
  miniopw=$(rand_hex 16)
  uploadsig=$(rand_hex 32)
  docker_gid=$(detect_docker_gid)

  cat >"$APPSTRATE_DIR/.env" <<EOF
# Generated by get.appstrate.dev on $(date -u +%Y-%m-%dT%H:%M:%SZ)
APPSTRATE_VERSION=$APPSTRATE_IMAGE_TAG

POSTGRES_USER=appstrate
POSTGRES_PASSWORD=$pg

BETTER_AUTH_SECRET=$auth
RUN_TOKEN_SECRET=$runtok
UPLOAD_SIGNING_SECRET=$uploadsig
CONNECTION_ENCRYPTION_KEY=$enckey

MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=$miniopw
S3_BUCKET=appstrate
S3_REGION=us-east-1

APP_URL=http://localhost:$APPSTRATE_PORT
TRUSTED_ORIGINS=http://localhost:$APPSTRATE_PORT
PORT=$APPSTRATE_PORT
LOG_LEVEL=info

SIDECAR_POOL_SIZE=2

DOCKER_GID=$docker_gid
EOF
  chmod 600 "$APPSTRATE_DIR/.env"
}

detect_docker_gid() {
  # Return the GID owning /var/run/docker.sock as seen INSIDE a container.
  # Host stat is unreliable: Docker Desktop / OrbStack rewrite ownership
  # when mounting the socket. Probe from inside a throwaway container.
  # Warns and falls back to 0 if probing fails (caller can override via .env).
  local gid
  if ! gid=$(docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    alpine:3 stat -c '%g' /var/run/docker.sock 2>/dev/null); then
    warn "Could not probe Docker socket GID — defaulting to 0 (override DOCKER_GID in .env if needed)"
    gid=0
  fi
  echo "${gid:-0}"
}

merge_env() {
  # Add any keys present in .env.example but missing from .env (no overwrite)
  local key
  while IFS= read -r line; do
    case "$line" in
      '' | \#*) continue ;;
    esac
    key=${line%%=*}
    [ -z "$key" ] && continue
    if ! grep -q "^${key}=" "$APPSTRATE_DIR/.env" 2>/dev/null; then
      # New key — needs a value
      case "$key" in
        BETTER_AUTH_SECRET | RUN_TOKEN_SECRET | UPLOAD_SIGNING_SECRET) echo "$key=$(rand_hex 32)" >>"$APPSTRATE_DIR/.env" ;;
        CONNECTION_ENCRYPTION_KEY) echo "$key=$(rand_b64 32)" >>"$APPSTRATE_DIR/.env" ;;
        POSTGRES_PASSWORD | MINIO_ROOT_PASSWORD) echo "$key=$(rand_hex 16)" >>"$APPSTRATE_DIR/.env" ;;
        *) echo "$line" >>"$APPSTRATE_DIR/.env" ;;
      esac
    fi
  done <"$APPSTRATE_DIR/.env.example"

  # Pin new APPSTRATE_VERSION
  if grep -q "^APPSTRATE_VERSION=" "$APPSTRATE_DIR/.env"; then
    sed_inplace "s|^APPSTRATE_VERSION=.*|APPSTRATE_VERSION=$APPSTRATE_IMAGE_TAG|" "$APPSTRATE_DIR/.env"
  else
    echo "APPSTRATE_VERSION=$APPSTRATE_IMAGE_TAG" >>"$APPSTRATE_DIR/.env"
  fi
}

sed_inplace() {
  local expr=$1 file=$2
  if sed --version >/dev/null 2>&1; then
    sed -i "$expr" "$file"
  else sed -i '' "$expr" "$file"; fi
}

rand_hex() { openssl rand -hex "$1"; }
rand_b64() { openssl rand -base64 "$1" | tr -d '\n'; }

pull_images() {
  if [ "$INSTALL_MODE" = "noop" ]; then return; fi
  if [ -n "$APPSTRATE_ASSETS_DIR" ]; then
    log "Skipping pull (local mode — using locally-tagged images, base images pulled on up)"
    return
  fi
  log "Pulling images (this may take a minute)"
  (cd "$APPSTRATE_DIR" && docker compose pull) >>"$LOG_FILE" 2>&1
}

start_services() {
  if [ "$INSTALL_MODE" = "noop" ]; then
    log "Already at $APPSTRATE_VERSION — ensuring services are running"
  fi
  log "Starting services"
  (cd "$APPSTRATE_DIR" && docker compose up -d) >>"$LOG_FILE" 2>&1
}

wait_for_health() {
  log "Waiting for services to become healthy"
  local deadline=$(($(date +%s) + 120))
  local url="http://localhost:$APPSTRATE_PORT/"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fs -o /dev/null --max-time 3 "$url" 2>>"$LOG_FILE"; then
      ok "appstrate is responding on $url"
      echo "$APPSTRATE_VERSION" >"$APPSTRATE_DIR/.version"
      return
    fi
    sleep 2
  done
  warn "appstrate did not become healthy within 120s — check 'appstrate logs'"
}

print_next_steps() {
  local elapsed=$(($(date +%s) - INSTALL_START))
  local mode_label
  case "$INSTALL_MODE" in
    fresh) mode_label="Installed" ;;
    upgrade) mode_label="Upgraded ($PREVIOUS_VERSION → $APPSTRATE_VERSION)" ;;
    noop) mode_label="Already at $APPSTRATE_VERSION" ;;
  esac
  printf "\n%b✓ %s in %ds%b\n" "$C_GREEN$C_BOLD" "$mode_label" "$elapsed" "$C_RESET"
  printf "%b────────────────────────────────────────────%b\n" "$C_DIM" "$C_RESET"
  cat <<EOF

Next:
  → Open http://localhost:$APPSTRATE_PORT
  → Sign up (first user becomes admin)
  → Settings → Models → add Claude / OpenAI key

Manage:
  cd $APPSTRATE_DIR
  docker compose ps              # status
  docker compose logs -f         # follow logs
  docker compose down            # stop (keeps data)
  docker compose down -v         # stop + delete all data
  curl -fsSL get.appstrate.dev | sh   # upgrade (re-run installer)

Docs: https://appstrate.dev/docs
Logs: $LOG_FILE
EOF
  printf "%b────────────────────────────────────────────%b\n\n" "$C_DIM" "$C_RESET"
}

# ─── Entry point — MUST be wrapped to protect against partial pipes ──────────
do_install() {
  [ "$APPSTRATE_QUIET" = "1" ] || print_banner
  detect_environment
  prepare_workdir
  determine_install_mode
  download_assets
  handle_env_file
  pull_images
  start_services
  wait_for_health
  [ "$APPSTRATE_QUIET" = "1" ] || print_next_steps
}

# Run only when executed directly (not when sourced — for BATS tests)
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  do_install
fi
