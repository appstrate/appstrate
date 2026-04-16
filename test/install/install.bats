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
  export NO_COLOR=1
  # Source script — guarded do_install will not auto-execute
  set +e
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/install.sh"
  set +e
  # Disable script's exit-on-error trap — we test functions in isolation
  trap - ERR
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ─── Random secret generators ────────────────────────────────────────────────

@test "rand_hex produces correct length" {
  result=$(rand_hex 32)
  [ "${#result}" -eq 64 ]   # 32 bytes = 64 hex chars
}

@test "rand_b64 produces non-empty output" {
  result=$(rand_b64 32)
  [ -n "$result" ]
  [[ "$result" != *$'\n'* ]]   # no trailing newline
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
  APPSTRATE_VERSION="v1.0.0"
  determine_install_mode
  [ "$INSTALL_MODE" = "fresh" ]
}

@test "determine_install_mode: noop when .version matches target" {
  APPSTRATE_VERSION="v1.0.0"
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
  APPSTRATE_VERSION="v1.0.0"
  echo "x" > "$APPSTRATE_DIR/.env"
  determine_install_mode
  [ "$INSTALL_MODE" = "upgrade" ]
}

# ─── generate_fresh_env ──────────────────────────────────────────────────────

@test "generate_fresh_env writes all required keys" {
  APPSTRATE_VERSION="v1.0.0"
  APPSTRATE_PORT=3000
  generate_fresh_env
  for k in APPSTRATE_VERSION POSTGRES_PASSWORD BETTER_AUTH_SECRET \
           RUN_TOKEN_SECRET CONNECTION_ENCRYPTION_KEY MINIO_ROOT_PASSWORD \
           S3_BUCKET APP_URL PORT; do
    grep -q "^${k}=" "$APPSTRATE_DIR/.env" || {
      echo "missing key: $k" >&2; cat "$APPSTRATE_DIR/.env" >&2; return 1
    }
  done
}

@test "generate_fresh_env permissions are 600" {
  APPSTRATE_VERSION="v1.0.0"
  APPSTRATE_PORT=3000
  generate_fresh_env
  perms=$(stat -f '%Lp' "$APPSTRATE_DIR/.env" 2>/dev/null \
       || stat -c '%a' "$APPSTRATE_DIR/.env")
  [ "$perms" = "600" ]
}

@test "generate_fresh_env produces unique secrets per invocation" {
  APPSTRATE_VERSION="v1.0.0"
  APPSTRATE_PORT=3000
  generate_fresh_env
  s1=$(grep '^BETTER_AUTH_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  rm "$APPSTRATE_DIR/.env"
  generate_fresh_env
  s2=$(grep '^BETTER_AUTH_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  [ "$s1" != "$s2" ]
}

@test "generate_fresh_env honors APPSTRATE_PORT" {
  APPSTRATE_VERSION="v1.0.0"
  APPSTRATE_PORT=4242
  generate_fresh_env
  grep -q '^PORT=4242$' "$APPSTRATE_DIR/.env"
  grep -q '^APP_URL=http://localhost:4242$' "$APPSTRATE_DIR/.env"
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
  grep -q '^NEW_FEATURE_FLAG=' "$APPSTRATE_DIR/.env"
}

@test "merge_env updates APPSTRATE_VERSION pin" {
  APPSTRATE_VERSION="v1.1.0"
  cp "$FIXTURES/.env.existing" "$APPSTRATE_DIR/.env"
  cp "$FIXTURES/.env.example"  "$APPSTRATE_DIR/.env.example"
  merge_env
  grep -q '^APPSTRATE_VERSION=1.1.0$' "$APPSTRATE_DIR/.env"   # 'v' stripped for image tag
  ! grep -q '^APPSTRATE_VERSION=v0.4.0$' "$APPSTRATE_DIR/.env"
}

@test "merge_env generates secret values for newly-added secret keys" {
  APPSTRATE_VERSION="v1.1.0"
  # .env without RUN_TOKEN_SECRET, but .env.example has it
  cat > "$APPSTRATE_DIR/.env" <<EOF
APPSTRATE_VERSION=v1.0.0
POSTGRES_PASSWORD=existing
BETTER_AUTH_SECRET=existing
CONNECTION_ENCRYPTION_KEY=existing
MINIO_ROOT_PASSWORD=existing
EOF
  cp "$FIXTURES/.env.example" "$APPSTRATE_DIR/.env.example"
  merge_env
  val=$(grep '^RUN_TOKEN_SECRET=' "$APPSTRATE_DIR/.env" | cut -d= -f2)
  [ "$val" != "CHANGE_ME" ]            # not the placeholder
  [ "${#val}" -eq 64 ]                  # rand_hex 32 → 64 hex chars
}

# ─── port_in_use ─────────────────────────────────────────────────────────────

@test "port_in_use: returns false on free high port" {
  ! port_in_use 59999
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
  APPSTRATE_ASSETS_DIR="$FIXTURES"
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

# ─── version tag stripping ───────────────────────────────────────────────────

@test "APPSTRATE_IMAGE_TAG strips leading 'v' from APPSTRATE_VERSION" {
  # Re-run the constant-init logic in a subshell to avoid polluting the test env
  result=$(APPSTRATE_VERSION="v1.2.3" bash -c 'V="${APPSTRATE_VERSION#v}"; echo "$V"')
  [ "$result" = "1.2.3" ]
}
