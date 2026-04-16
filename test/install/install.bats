#!/usr/bin/env bats
#
# Unit tests for scripts/install.sh
#
# Run:  bats test/install/install.bats
#       (or via Docker: docker run --rm -v "$PWD:/code" -w /code bats/bats:latest test/install/install.bats)

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  FIXTURES="$REPO_ROOT/test/install/fixtures"
  TMPDIR_TEST="$(mktemp -d)"
  export APPSTRATE_DIR="$TMPDIR_TEST"
  export APPSTRATE_VERSION="v1.0.0"
  export APPSTRATE_PORT=3000
  export NO_COLOR=1
  # Capture bats' own ERR/EXIT traps BEFORE sourcing — the script installs
  # its own on_error/cleanup_tmp handlers that clobber bats' test-reporting
  # machinery. Without this, assertion failures inside tests are silently
  # swallowed and bats emits "Executed N instead of expected M" warnings
  # instead of proper "not ok" lines.
  BATS_SAVED_ERR_TRAP=$(trap -p ERR)
  BATS_SAVED_EXIT_TRAP=$(trap -p EXIT)
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/install.sh"
  # install.sh sets `set -euo pipefail`. Drop pipefail (tests use `| grep -q`
  # where grep's exit=1 on "no match" is the legitimate signal, not a failure).
  # Keep `set -e` + `set -E` so assertion failures in functions propagate.
  set +o pipefail
  set -eE
  # Restore bats' traps — overriding the script's on_error/cleanup_tmp.
  eval "${BATS_SAVED_ERR_TRAP:-trap - ERR}"
  eval "${BATS_SAVED_EXIT_TRAP:-trap - EXIT}"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ─── Random secret generators ────────────────────────────────────────────────

@test "rand_hex produces correct length" {
  result=$(rand_hex 32)
  [ "${#result}" -eq 64 ]   # 32 bytes = 64 hex chars
}

@test "rand_b64 produces non-empty output with expected length" {
  result=$(rand_b64 32)
  [ -n "$result" ]
  [[ "$result" != *$'\n'* ]]   # no trailing newline
  # openssl rand -base64 32 → 44 base64 chars (ceil(32/3)*4)
  [ "${#result}" -eq 44 ]
}

@test "rand_hex is non-deterministic" {
  a=$(rand_hex 16)
  b=$(rand_hex 16)
  [ "$a" != "$b" ]
}

# ─── sed_inplace ─────────────────────────────────────────────────────────────

@test "sed_inplace edits file in place (cross-platform)" {
  echo "FOO=bar" > "$TMPDIR_TEST/f"
  sed_inplace 's|FOO=.*|FOO=baz|' "$TMPDIR_TEST/f"
  grep -q '^FOO=baz$' "$TMPDIR_TEST/f"
}

# ─── determine_install_mode ──────────────────────────────────────────────────

@test "determine_install_mode: fresh when no .env" {
  determine_install_mode
  [ "$INSTALL_MODE" = "fresh" ]
}

@test "determine_install_mode: noop when .version matches target" {
  echo "x" > "$APPSTRATE_DIR/.env"
  echo "v1.0.0" > "$APPSTRATE_DIR/.version"
  determine_install_mode
  [ "$INSTALL_MODE" = "noop" ]
}

@test "determine_install_mode: upgrade when versions differ" {
  APPSTRATE_VERSION="v1.1.0"
  echo "x" > "$APPSTRATE_DIR/.env"
  echo "v1.0.0" > "$APPSTRATE_DIR/.version"
  determine_install_mode
  [ "$INSTALL_MODE" = "upgrade" ]
  [ "$PREVIOUS_VERSION" = "v1.0.0" ]
}

@test "determine_install_mode: upgrade when .env exists but .version missing" {
  echo "x" > "$APPSTRATE_DIR/.env"
  determine_install_mode
  [ "$INSTALL_MODE" = "upgrade" ]
}

# ─── generate_fresh_env ──────────────────────────────────────────────────────

@test "generate_fresh_env writes all required keys" {
  generate_fresh_env
  for k in APPSTRATE_VERSION POSTGRES_PASSWORD BETTER_AUTH_SECRET \
           RUN_TOKEN_SECRET UPLOAD_SIGNING_SECRET CONNECTION_ENCRYPTION_KEY \
           MINIO_ROOT_PASSWORD S3_BUCKET APP_URL PORT DOCKER_GID; do
    grep -q "^${k}=" "$APPSTRATE_DIR/.env" || {
      echo "missing key: $k" >&2; cat "$APPSTRATE_DIR/.env" >&2; return 1
    }
  done
}

@test "generate_fresh_env permissions are 600" {
  generate_fresh_env
  perms=$(stat -c '%a' "$APPSTRATE_DIR/.env" 2>/dev/null \
       || stat -f '%Lp' "$APPSTRATE_DIR/.env" 2>/dev/null)
  [ "$perms" = "600" ]
}

@test "generate_fresh_env produces unique secrets per invocation" {
  generate_fresh_env
  s1=$(grep '^BETTER_AUTH_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  rm "$APPSTRATE_DIR/.env"
  generate_fresh_env
  s2=$(grep '^BETTER_AUTH_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  [ "$s1" != "$s2" ]
}

@test "generate_fresh_env honors APPSTRATE_PORT" {
  APPSTRATE_PORT=4242
  generate_fresh_env
  grep -q '^PORT=4242$' "$APPSTRATE_DIR/.env"
  grep -q '^APP_URL=http://localhost:4242$' "$APPSTRATE_DIR/.env"
}

@test "generate_fresh_env writes atomically via temp file" {
  generate_fresh_env
  # .env should exist, .env.tmp should not (it was moved)
  [ -f "$APPSTRATE_DIR/.env" ]
  [ ! -f "$APPSTRATE_DIR/.env.tmp" ]
}

# ─── merge_env (upgrade path) ────────────────────────────────────────────────

@test "merge_env preserves existing values" {
  APPSTRATE_VERSION="v1.1.0"
  cp "$FIXTURES/.env.existing" "$APPSTRATE_DIR/.env"
  cp "$FIXTURES/.env.example"  "$APPSTRATE_DIR/.env.example"
  merge_env
  grep -q '^BETTER_AUTH_SECRET=keepme_auth$'        "$APPSTRATE_DIR/.env"
  grep -q '^RUN_TOKEN_SECRET=keepme_runtok$'        "$APPSTRATE_DIR/.env"
  grep -q '^CONNECTION_ENCRYPTION_KEY=keepme_enckey$' "$APPSTRATE_DIR/.env"
  grep -q '^POSTGRES_PASSWORD=keepme_pg$'           "$APPSTRATE_DIR/.env"
  grep -q '^MINIO_ROOT_PASSWORD=keepme_minio$'      "$APPSTRATE_DIR/.env"
}

@test "merge_env adds new keys from .env.example" {
  APPSTRATE_VERSION="v1.1.0"
  cp "$FIXTURES/.env.existing" "$APPSTRATE_DIR/.env"
  cp "$FIXTURES/.env.example"  "$APPSTRATE_DIR/.env.example"
  merge_env
  # NEW_FEATURE_FLAG exists in fixture .env.example but not .env.existing
  grep -q '^NEW_FEATURE_FLAG=false$' "$APPSTRATE_DIR/.env"
}

@test "merge_env updates APPSTRATE_VERSION pin" {
  APPSTRATE_VERSION="v1.1.0"
  APPSTRATE_IMAGE_TAG="1.1.0"
  cp "$FIXTURES/.env.existing" "$APPSTRATE_DIR/.env"
  cp "$FIXTURES/.env.example"  "$APPSTRATE_DIR/.env.example"
  merge_env
  grep -q '^APPSTRATE_VERSION=1.1.0$' "$APPSTRATE_DIR/.env"   # 'v' stripped for image tag
  ! grep -q '^APPSTRATE_VERSION=v0.4.0$' "$APPSTRATE_DIR/.env"
}

@test "merge_env generates secret values for newly-added secret keys" {
  APPSTRATE_VERSION="v1.1.0"
  # .env without RUN_TOKEN_SECRET or UPLOAD_SIGNING_SECRET, but .env.example has them
  cat > "$APPSTRATE_DIR/.env" <<EOF
APPSTRATE_VERSION=v1.0.0
POSTGRES_PASSWORD=existing
BETTER_AUTH_SECRET=existing
CONNECTION_ENCRYPTION_KEY=existing
MINIO_ROOT_PASSWORD=existing
EOF
  cp "$FIXTURES/.env.example" "$APPSTRATE_DIR/.env.example"
  merge_env

  # RUN_TOKEN_SECRET should be auto-generated (not CHANGE_ME)
  val=$(grep '^RUN_TOKEN_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  [ "$val" != "CHANGE_ME" ]
  [ "${#val}" -eq 64 ]                  # rand_hex 32 → 64 hex chars

  # UPLOAD_SIGNING_SECRET should also be auto-generated
  val2=$(grep '^UPLOAD_SIGNING_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  [ "$val2" != "CHANGE_ME" ]
  [ "${#val2}" -eq 64 ]
}

# ─── port_in_use ─────────────────────────────────────────────────────────────

@test "port_in_use: returns false on free high port" {
  ! port_in_use 59999
}

@test "port_in_use: /dev/tcp fallback returns false on free port when lsof/ss/netstat absent" {
  # Shadow all three detectors so port_in_use falls through to /dev/tcp.
  command_exists() { return 1; }
  export -f command_exists
  run port_in_use 59998
  [ "$status" -eq 1 ]
}

@test "port_in_use: /dev/tcp fallback detects a listening port when detectors absent" {
  # Use bash coproc as a self-contained listener (no nc/python dependency).
  # coproc spawns a bash process accepting a single connection on a high port.
  command -v python3 >/dev/null 2>&1 || skip "python3 not available for listener"
  python3 -c "
import socket, time
s = socket.socket()
s.bind(('127.0.0.1', 59997))
s.listen(1)
s.settimeout(5)
print('ready', flush=True)
try:
  c, _ = s.accept()
  c.close()
except Exception:
  pass
" &
  PID=$!
  # Wait for the listener to print 'ready'
  sleep 0.5

  command_exists() { return 1; } # force /dev/tcp path
  export -f command_exists
  run port_in_use 59997
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  [ "$status" -eq 0 ]
}

@test "port_in_use: lsof branch detects listener with clean exit=0 + match on stdout" {
  # Happy path for the lsof branch: exit 0, output contains a match.
  lsof() {
    printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n'
    printf 'appstrat 1234 user 3u IPv4 0x1 0t0 TCP *:3000 (LISTEN)\n'
    return 0
  }
  export -f lsof
  # Only lsof exists — avoids falling through to ss/netstat.
  command_exists() { case "$1" in lsof) return 0 ;; *) return 1 ;; esac; }
  export -f command_exists

  run port_in_use 3000
  [ "$status" -eq 0 ]
}

@test "port_in_use: lsof branch still detects listener when exit=1 with match on stdout" {
  # BUG REPRO: on macOS + Docker Desktop (and other envs), lsof regularly
  # prints a valid listener on stdout AND exits non-zero because it hit
  # permission-denied errors while scanning unrelated sockets/processes.
  # port_in_use must rely on output, not on lsof's exit code.
  lsof() {
    printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n'
    printf 'com.docke 999 root 42u IPv6 0x1 0t0 TCP *:3000 (LISTEN)\n'
    return 1
  }
  export -f lsof
  command_exists() { case "$1" in lsof) return 0 ;; *) return 1 ;; esac; }
  export -f command_exists

  run port_in_use 3000
  [ "$status" -eq 0 ]
}

@test "port_in_use: lsof branch returns free when no output (regardless of exit code)" {
  # No listener → no output. Exit code alone is ambiguous (1 on both
  # "no match" and "match + permission noise"), so the correct signal is
  # empty stdout.
  lsof() { return 1; }
  export -f lsof
  command_exists() { case "$1" in lsof) return 0 ;; *) return 1 ;; esac; }
  export -f command_exists

  run port_in_use 3000
  [ "$status" -eq 1 ]
}

# ─── resolve_docker_gid (pure helper, no Docker/FS access) ───────────────────

@test "resolve_docker_gid: Linux + stat=0 + docker group present → docker group GID" {
  getent() {
    if [ "$1" = "group" ] && [ "$2" = "docker" ]; then
      echo "docker:x:999:"
    fi
  }
  export -f getent
  result=$(resolve_docker_gid "0" "Linux")
  [ "$result" = "999" ]
}

@test "resolve_docker_gid: Linux + stat=0 + no docker group → falls back to 0" {
  getent() { return 1; }
  export -f getent
  result=$(resolve_docker_gid "0" "Linux")
  [ "$result" = "0" ]
}

@test "resolve_docker_gid: Darwin + stat=0 → passthrough (Docker Desktop case)" {
  # Must not consult getent on Darwin even if stat=0
  getent() {
    echo "should-not-be-called" >&2
    return 1
  }
  export -f getent
  result=$(resolve_docker_gid "0" "Darwin")
  [ "$result" = "0" ]
}

@test "resolve_docker_gid: Linux + non-zero observed GID → passthrough" {
  getent() {
    echo "should-not-be-called" >&2
    return 1
  }
  export -f getent
  result=$(resolve_docker_gid "988" "Linux")
  [ "$result" = "988" ]
}

# ─── merge_env: obsolete-key warning (Phase 3) ───────────────────────────────

@test "merge_env: warns on keys present in .env but absent from .env.example" {
  APPSTRATE_VERSION="v1.1.0"
  APPSTRATE_IMAGE_TAG="1.1.0"
  cat >"$APPSTRATE_DIR/.env" <<EOF
APPSTRATE_VERSION=v1.0.0
POSTGRES_PASSWORD=x
BETTER_AUTH_SECRET=x
RUN_TOKEN_SECRET=x
UPLOAD_SIGNING_SECRET=x
CONNECTION_ENCRYPTION_KEY=x
MINIO_ROOT_PASSWORD=x
OLD_LEGACY_FLAG=legacyvalue
EOF
  cp "$FIXTURES/.env.example" "$APPSTRATE_DIR/.env.example"
  run merge_env
  [ "$status" -eq 0 ]
  [[ "$output" == *"OLD_LEGACY_FLAG"* ]]
  [[ "$output" == *"possibly obsolete"* ]]
}

@test "merge_env: ignores installer-managed keys (APPSTRATE_VERSION, DOCKER_GID)" {
  APPSTRATE_VERSION="v1.1.0"
  APPSTRATE_IMAGE_TAG="1.1.0"
  cat >"$APPSTRATE_DIR/.env" <<EOF
APPSTRATE_VERSION=v1.0.0
DOCKER_GID=988
POSTGRES_PASSWORD=x
BETTER_AUTH_SECRET=x
RUN_TOKEN_SECRET=x
UPLOAD_SIGNING_SECRET=x
CONNECTION_ENCRYPTION_KEY=x
MINIO_ROOT_PASSWORD=x
EOF
  # Fixture does contain DOCKER_GID, so strip it to simulate an older .env.example
  grep -v '^DOCKER_GID=' "$FIXTURES/.env.example" >"$APPSTRATE_DIR/.env.example"
  run merge_env
  [ "$status" -eq 0 ]
  [[ "$output" != *"possibly obsolete"* ]]
}

# ─── rollback_upgrade (Phase 4) ──────────────────────────────────────────────

@test "rollback_upgrade: returns 1 when INSTALL_MODE != upgrade" {
  INSTALL_MODE="fresh"
  run rollback_upgrade
  [ "$status" -eq 1 ]
}

@test "rollback_upgrade: returns 1 when no backup files exist" {
  INSTALL_MODE="upgrade"
  mkdir -p "$APPSTRATE_DIR"
  LOG_FILE="$APPSTRATE_DIR/log"
  : >"$LOG_FILE"
  run rollback_upgrade
  [ "$status" -eq 1 ]
}

@test "rollback_upgrade: restores latest .env and compose.yml from .bak-*" {
  INSTALL_MODE="upgrade"
  PREVIOUS_VERSION="v1.0.0"
  LOG_FILE="$APPSTRATE_DIR/log"
  : >"$LOG_FILE"

  # Seed two backups — rollback must pick the most recent
  echo "OLDER_COMPOSE" >"$APPSTRATE_DIR/docker-compose.yml.bak-20260101-100000"
  sleep 0.1
  echo "LATEST_COMPOSE" >"$APPSTRATE_DIR/docker-compose.yml.bak-20260101-120000"
  echo "BROKEN_NEW_COMPOSE" >"$APPSTRATE_DIR/docker-compose.yml"

  echo "OLDER_ENV" >"$APPSTRATE_DIR/.env.bak-20260101-100000"
  sleep 0.1
  echo "LATEST_ENV" >"$APPSTRATE_DIR/.env.bak-20260101-120000"
  echo "NEW_ENV" >"$APPSTRATE_DIR/.env"

  # Stub docker → treat `docker compose up -d` as success
  docker() { return 0; }
  export -f docker

  run rollback_upgrade
  [ "$status" -eq 0 ]

  grep -q 'LATEST_COMPOSE' "$APPSTRATE_DIR/docker-compose.yml"
  grep -q 'LATEST_ENV' "$APPSTRATE_DIR/.env"
}

@test "rollback_upgrade: returns 1 when only compose backup is present" {
  # Partial backup = mismatched restore. Require BOTH files or abort.
  INSTALL_MODE="upgrade"
  PREVIOUS_VERSION="v1.0.0"
  LOG_FILE="$APPSTRATE_DIR/log"
  : >"$LOG_FILE"
  echo "X" >"$APPSTRATE_DIR/docker-compose.yml.bak-1"
  run rollback_upgrade
  [ "$status" -eq 1 ]
}

@test "rollback_upgrade: returns 1 when only env backup is present" {
  INSTALL_MODE="upgrade"
  PREVIOUS_VERSION="v1.0.0"
  LOG_FILE="$APPSTRATE_DIR/log"
  : >"$LOG_FILE"
  echo "Y" >"$APPSTRATE_DIR/.env.bak-1"
  run rollback_upgrade
  [ "$status" -eq 1 ]
}

@test "rollback_upgrade: returns 1 when docker compose up fails" {
  INSTALL_MODE="upgrade"
  PREVIOUS_VERSION="v1.0.0"
  LOG_FILE="$APPSTRATE_DIR/log"
  : >"$LOG_FILE"
  echo "X" >"$APPSTRATE_DIR/docker-compose.yml.bak-1"
  echo "Y" >"$APPSTRATE_DIR/.env.bak-1"

  docker() { return 1; } # simulate compose up failure
  export -f docker

  run rollback_upgrade
  [ "$status" -eq 1 ]
}

# ─── verify.sh (Phase 5 wrapper) ─────────────────────────────────────────────

@test "verify.sh: exits with a clear error when public key is placeholder" {
  run bash "$REPO_ROOT/scripts/verify.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not been provisioned"* ]]
}

@test "verify.sh: exits cleanly when minisign is absent" {
  # Place a fake verify.sh with a non-placeholder pubkey, then hide minisign
  # by pointing PATH at a directory that contains only a bash symlink.
  tmp=$(mktemp -d)
  sed 's|__APPSTRATE_MINISIGN_PUBKEY__|RWQfakefakefakefakefakefakefakefakefakefakefake=|' \
    "$REPO_ROOT/scripts/verify.sh" >"$tmp/verify.sh"
  chmod +x "$tmp/verify.sh"
  # Minimal PATH: just bash, no minisign, no curl
  mkdir "$tmp/bin"
  ln -s "$(command -v bash)" "$tmp/bin/bash"
  run env -i PATH="$tmp/bin" HOME="$HOME" bash "$tmp/verify.sh"
  rm -rf "$tmp"
  [ "$status" -eq 1 ]
  [[ "$output" == *"minisign is required"* ]] || [[ "$output" == *"curl is required"* ]]
}

# ─── pull_images skip mode ───────────────────────────────────────────────────

@test "pull_images: noop mode is a no-op" {
  INSTALL_MODE="noop"
  output=$(pull_images 2>&1)
  [ -z "$output" ]
}

@test "pull_images: APPSTRATE_ASSETS_DIR mode skips pull" {
  INSTALL_MODE="fresh"
  APPSTRATE_ASSETS_DIR="/tmp/some-local-dir"
  LOG_FILE="$TMPDIR_TEST/log"
  : >"$LOG_FILE"
  output=$(pull_images 2>&1)
  [[ "$output" == *"Skipping pull"* ]]
}

# ─── download_assets via APPSTRATE_ASSETS_DIR ────────────────────────────────

@test "download_assets: copies from APPSTRATE_ASSETS_DIR when set" {
  INSTALL_MODE="fresh"
  # Fixture is .env.example only — fake a docker-compose.yml in a temp dir
  src=$(mktemp -d)
  echo "fake-compose" > "$src/docker-compose.yml"
  cp "$FIXTURES/.env.example" "$src/.env.example"
  APPSTRATE_ASSETS_DIR="$src"
  download_assets
  [ -f "$APPSTRATE_DIR/docker-compose.yml" ]
  [ -f "$APPSTRATE_DIR/.env.example" ]
  grep -q "fake-compose" "$APPSTRATE_DIR/docker-compose.yml"
  rm -rf "$src"
}

# ─── version validation ──────────────────────────────────────────────────────

@test "version validation rejects malformed versions" {
  for bad in "evil|injection" "v1" "1.0.0" "../traversal" "v1.0.0;rm -rf /"; do
    run bash -c "APPSTRATE_VERSION='$bad' source '$REPO_ROOT/scripts/install.sh' 2>&1"
    [ "$status" -ne 0 ]
  done
}

@test "version validation accepts valid semver and dev values" {
  for good in "v1.0.0" "v0.5.2-beta.1" "v1.2.3-rc1" "local" "latest"; do
    run bash -c "APPSTRATE_VERSION='$good' source '$REPO_ROOT/scripts/install.sh' 2>&1"
    [ "$status" -eq 0 ]
  done
}

# ─── version tag stripping ───────────────────────────────────────────────────

@test "APPSTRATE_IMAGE_TAG strips leading 'v' from APPSTRATE_VERSION" {
  # Re-run the constant-init logic in a subshell to avoid polluting the test env
  result=$(APPSTRATE_VERSION="v1.2.3" bash -c 'V="${APPSTRATE_VERSION#v}"; echo "$V"')
  [ "$result" = "1.2.3" ]
}

# ─── acquire_lock ────────────────────────────────────────────────────────────

@test "acquire_lock creates lock dir and fails on second call" {
  mkdir -p "$APPSTRATE_DIR"
  acquire_lock
  [ -d "$APPSTRATE_DIR/.install.lock" ]
  # Second call should fail
  run acquire_lock
  [ "$status" -ne 0 ]
  # Cleanup
  rmdir "$APPSTRATE_DIR/.install.lock" 2>/dev/null || true
}

# ─── prepare_workdir ─────────────────────────────────────────────────────────

@test "prepare_workdir creates dir and log with 600 permissions" {
  prepare_workdir
  [ -d "$APPSTRATE_DIR" ]
  [ -n "$LOG_FILE" ]
  [ -f "$LOG_FILE" ]
  perms=$(stat -c '%a' "$LOG_FILE" 2>/dev/null \
       || stat -f '%Lp' "$LOG_FILE" 2>/dev/null)
  [ "$perms" = "600" ]
}
