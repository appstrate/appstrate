#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Appstrate CLI bootstrap — thin downloader for `get.appstrate.dev`.
#
# Single responsibility: detect OS + arch, download the matching
# `appstrate` CLI binary from the GitHub Release whose tag is pinned
# by `publish-installer.yml` at publish time (or `latest` if this
# script is being run from a raw source copy), VERIFY its integrity
# + provenance against a minisign-signed SHA-256 manifest, drop it on
# PATH, and exec `appstrate install` to hand control to the CLI itself.
#
# No install logic lives here — tier selection, secrets generation,
# compose rendering, healthchecks, and upgrades are all owned by the
# CLI binary. This script stays small on purpose.
#
# Trust chain:
#   1. `scripts/verify.sh` (served at `get.appstrate.dev/verify.sh`)
#      verifies the signature on THIS script before executing it. That
#      is the opt-in wrapper for users who refuse trust-on-TLS at the
#      `get.appstrate.dev | bash` step.
#   2. THIS script then downloads + verifies the signature on the
#      per-release `checksums.txt` against the baked-in public key,
#      then verifies the SHA-256 of the downloaded binary matches.
#      The CLI binary is never exec'd until both checks pass.
#
# Usage:
#   curl -fsSL https://get.appstrate.dev | bash
#   curl -fsSL https://get.appstrate.dev | bash -s -- --tier 3
#
# Env overrides:
#   APPSTRATE_VERSION             Pin a release tag (default: pinned or "latest").
#   APPSTRATE_BIN_DIR             Install location (default: $HOME/.local/bin).
#                                 Set to /usr/local/bin for a system-wide install
#                                 (sudo will be requested).
#   APPSTRATE_NO_MODIFY_PATH=1    Do not touch shell rc files to add BIN_DIR to
#                                 PATH. Equivalent to uv's UV_NO_MODIFY_PATH.
#   APPSTRATE_SKIP_VERIFY=1       Skip signature + checksum verification (CI
#                                 debug only — do NOT set on user machines).
#   APPSTRATE_NO_INSTALL_MINISIGN=1
#                                 Do not attempt to auto-install `minisign` via
#                                 the host package manager when it's missing.
#                                 The script falls back to the original
#                                 instructions-then-exit behaviour.

set -euo pipefail

# The entire script body is wrapped in `_appstrate_bootstrap` and only
# invoked at the very end of the file. `curl -fsSL … | bash` reads the
# script over a streaming TCP connection; if the connection drops
# mid-transfer, bash would otherwise execute whatever bytes arrived —
# potentially the top half of a security-critical flow (download but
# skip verification). Defining everything inside a function means the
# shell must parse the whole file before reaching the invocation; a
# truncated download produces a syntax error that exits non-zero
# instead of a partial execution.
_appstrate_bootstrap() {

  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *)
      echo "Unsupported architecture: $ARCH" >&2
      exit 1
      ;;
  esac

  case "$OS" in
    darwin | linux) ;;
    *)
      # Windows is deliberately not a v1 target — see ADR-006 § Deliverable.
      # The recommended path on Windows is WSL2 (which reuses the linux-x64
      # binary); `bunx appstrate install` is the Bun-native escape
      # hatch for users who have Bun but no WSL2. We fail loud here instead
      # of hinting at a flow this script doesn't handle.
      echo "Unsupported OS: $OS." >&2
      echo "On Windows, run this inside WSL2 (recommended), or install natively via: bunx appstrate install" >&2
      exit 1
      ;;
  esac

  # Default version pinned by `publish-installer.yml` at publish time —
  # rewriting `__APPSTRATE_VERSION__` so `curl get.appstrate.dev | bash`
  # downloads the binary matching the release that published this script.
  # Users can override via APPSTRATE_VERSION env var (e.g. to pin an older
  # release). When the placeholder is still present (local dev / unrendered
  # copy), fall back to `latest` so the script stays runnable out of tree.
  _DEFAULT_VERSION="__APPSTRATE_VERSION__"
  if [[ "$_DEFAULT_VERSION" == __* ]]; then _DEFAULT_VERSION="latest"; fi
  VERSION="${APPSTRATE_VERSION:-$_DEFAULT_VERSION}"
  # Rootless default: install into $HOME/.local/bin (XDG user-space equivalent
  # of /usr/local/bin). Matches uv, rustup, Bun, Deno, pipx — avoids a sudo
  # prompt on the happy path, works in containers / CI without privileges, and
  # contains blast radius if the binary is ever compromised (can't escape $HOME).
  # Users who want a system-wide install can opt in via APPSTRATE_BIN_DIR.
  BIN_DIR="${APPSTRATE_BIN_DIR:-$HOME/.local/bin}"
  DEST="${BIN_DIR}/appstrate"
  ASSET="appstrate-${OS}-${ARCH}"

  # Appstrate minisign public key — baked into the distributed
  # bootstrap.sh so a freshly-bootstrapped machine can verify without a
  # second round-trip. Matches `scripts/appstrate.pub` in the repo; the
  # release workflow signs `checksums.txt` with the matching private key.
  # Rotation SOP: docs/adr/ADR-006-cli-device-flow-monorepo.md.
  APPSTRATE_MINISIGN_PUBKEY="RWT6xCZCCP/yHolAgDuDqBssxUflw7gInlZlaXEfQ4cFi5XN0KCtKr0e"

  if [ "$VERSION" = "latest" ]; then
    URL_BASE="https://github.com/appstrate/appstrate/releases/latest/download"
  else
    URL_BASE="https://github.com/appstrate/appstrate/releases/download/${VERSION}"
  fi
  URL="${URL_BASE}/${ASSET}"
  CHECKSUMS_URL="${URL_BASE}/checksums.txt"
  CHECKSUMS_SIG_URL="${URL_BASE}/checksums.txt.minisig"

  # ─── Helpers ────────────────────────────────────────────────────────────────

  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT

  warn() { printf '\033[0;33m⚠\033[0m  %s\n' "$*" >&2; }
  log() { printf '\033[0;36m→\033[0m  %s\n' "$*"; }
  err() { printf '\033[0;31m✗\033[0m  %s\n' "$*" >&2; }

  have_sha256sum() { command -v sha256sum >/dev/null 2>&1; }
  have_shasum() { command -v shasum >/dev/null 2>&1; }
  have_minisign() { command -v minisign >/dev/null 2>&1; }

  # ─── minisign auto-install (issue #470) ─────────────────────────────────────
  #
  # The one-liner one-step UX promise ("paste this, get a running Appstrate")
  # breaks on every Debian-family box without minisign pre-installed: the
  # verification gate is non-negotiable, so the script otherwise dies asking
  # the user to apt-install a package and re-run. Detect the host package
  # manager, install minisign ourselves, and proceed — same trust assumption
  # as the `curl … | bash` step (user trusts get.appstrate.dev over TLS).
  #
  # Auto-install fires in three contexts without a prompt:
  #   1. `--yes` arg present (advertised one-liner on the homepage)
  #   2. CI=true|1|yes (any CI runner — non-interactive by definition)
  #   3. No TTY available for a prompt (piped from another script, systemd…)
  # In an interactive TTY without any of the above, a y/N prompt fires
  # (defaults to Y — declining mirrors the legacy hint-and-exit behaviour).
  #
  # APPSTRATE_NO_INSTALL_MINISIGN=1 opts out entirely.

  # Pick the first available package manager. We don't auto-install on
  # distros we haven't validated (the install command differs and the wrong
  # incantation against the wrong manager is worse than failing closed).
  detect_minisign_installer() {
    if [ "$OS" = "darwin" ]; then
      command -v brew >/dev/null 2>&1 && { printf 'brew'; return; }
    else
      command -v apt-get >/dev/null 2>&1 && { printf 'apt'; return; }
      command -v apk >/dev/null 2>&1 && { printf 'apk'; return; }
      command -v dnf >/dev/null 2>&1 && { printf 'dnf'; return; }
      command -v pacman >/dev/null 2>&1 && { printf 'pacman'; return; }
      command -v zypper >/dev/null 2>&1 && { printf 'zypper'; return; }
    fi
    return 1
  }

  # Build the install command for `$1` (manager name). Prepends `sudo` only
  # when not already root AND `sudo` is on PATH — keeps containerised installs
  # (root, no sudo binary) working without a spurious "sudo: not found" trap.
  minisign_install_cmd() {
    _mgr="$1"
    _sudo=""
    if [ "$(id -u 2>/dev/null || echo 0)" != "0" ] && command -v sudo >/dev/null 2>&1; then
      _sudo="sudo"
    fi
    case "$_mgr" in
      brew) printf 'brew install minisign' ;;
      apt) printf '%s DEBIAN_FRONTEND=noninteractive apt-get install -y minisign' "$_sudo" ;;
      apk) printf '%s apk add --no-cache minisign' "$_sudo" ;;
      dnf) printf '%s dnf install -y minisign' "$_sudo" ;;
      pacman) printf '%s pacman -S --noconfirm minisign' "$_sudo" ;;
      zypper) printf '%s zypper install -y minisign' "$_sudo" ;;
      *) return 1 ;;
    esac
  }

  # apt-get install fails on a stale package cache (very common on fresh
  # Ubuntu images — `/var/lib/apt/lists` is empty). Refresh once before
  # the install attempt; ignore failures (the install step will surface a
  # real error if the index actually can't be fetched).
  apt_refresh_if_needed() {
    _sudo=""
    if [ "$(id -u 2>/dev/null || echo 0)" != "0" ] && command -v sudo >/dev/null 2>&1; then
      _sudo="sudo"
    fi
    # `-qq` keeps the refresh quiet; the bootstrap is the only voice the
    # user should hear in the happy path.
    $_sudo apt-get update -qq >/dev/null 2>&1 || true
  }

  # Returns 0 if minisign got installed, non-zero otherwise. Caller decides
  # how to react — we don't `exit` from here so the surrounding flow keeps
  # owning the error UX.
  try_install_minisign() {
    _mgr="$(detect_minisign_installer)" || return 1
    _cmd="$(minisign_install_cmd "$_mgr")" || return 1
    log "Installing minisign via $_mgr (required for signature verification)"
    log "  \$ $_cmd"
    # apt needs a fresh package index on stock cloud-init / Docker images.
    if [ "$_mgr" = "apt" ]; then apt_refresh_if_needed; fi
    # `sh -c` rather than direct exec so the sudo prefix expands correctly
    # and we never have to special-case the leading-empty-string case.
    if ! sh -c "$_cmd"; then
      err "Failed to install minisign via $_mgr."
      return 1
    fi
    if ! have_minisign; then
      err "minisign install reported success but the binary is still not on PATH."
      return 1
    fi
    return 0
  }

  # ─── Dual-install pre-check (issue #249, phase 4) ───────────────────────────
  #
  # If the user already has `appstrate` on PATH at a DIFFERENT location than
  # the one we're about to write, the two binaries will silently shadow each
  # other after the install — the order on $PATH decides which one runs, and
  # `appstrate self-update` will only ever update one of them. uv, deno, bun,
  # rustup all surface this case at runtime; nobody surfaces it at install
  # time. We do, because we have $DEST in hand before we touch the disk.
  #
  # Behavior:
  #   - Same path (re-install over self) → silent no-op, proceed.
  #   - Different path + interactive TTY → prompt [y/N], abort by default.
  #   - Different path + CI / non-TTY  → abort with a hint to set
  #                                       APPSTRATE_FORCE_DUAL=1.
  #   - APPSTRATE_FORCE_DUAL=1         → bypass the check entirely.
  #
  # We do this BEFORE downloading the binary so a user who chose the wrong
  # install method doesn't burn bandwidth + minisign cycles on something
  # they're going to abort 10 seconds later.
  resolve_path() {
    # POSIX-portable path resolver tolerant of non-existent leaf files.
    #
    # Why split dir + basename: BSD `realpath` (macOS default) and GNU
    # `readlink -f` both fail on a non-existent path, but DEST = the file
    # we're about to write doesn't exist yet on a fresh install. Resolving
    # only the parent dir handles every scenario where one or both paths
    # are missing while still canonicalising symlinks at the directory
    # level (the common case — e.g. /usr/local/bin → /opt/homebrew/bin
    # on macOS Homebrew). Symlinks AT the leaf are not resolved, but a
    # symlink at the binary itself is uncommon and a false-positive
    # warning on that edge case beats a false-negative dual-install miss.
    _input="$1"
    _dir="$(dirname -- "$_input")"
    _base="$(basename -- "$_input")"
    if command -v realpath >/dev/null 2>&1; then
      _real_dir="$(realpath "$_dir" 2>/dev/null || printf '%s' "$_dir")"
    elif command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
      _real_dir="$(readlink -f "$_dir" 2>/dev/null || printf '%s' "$_dir")"
    else
      _real_dir="$_dir"
    fi
    printf '%s/%s' "$_real_dir" "$_base"
  }

  EXISTING_APPSTRATE="$(command -v appstrate 2>/dev/null || true)"
  if [ -n "$EXISTING_APPSTRATE" ] && [ "${APPSTRATE_FORCE_DUAL:-0}" != "1" ]; then
    EXISTING_REAL="$(resolve_path "$EXISTING_APPSTRATE")"
    DEST_REAL="$(resolve_path "$DEST")"
    # Only act on a TRUE dual-install. Re-running the bootstrap on a machine
    # that already has the curl-channel binary at $DEST is a normal re-install
    # — we don't want to nag.
    if [ "$EXISTING_REAL" != "$DEST_REAL" ]; then
      # Wrap the probe in a 2s timeout: a wedged or interactive existing
      # binary (e.g. one stuck on a TTY prompt because $stdin isn't a TTY
      # under `curl | bash`) would otherwise hang the bootstrap forever.
      # `timeout` is GNU; on macOS without coreutils we fall back to
      # `gtimeout` if installed, else accept the (rare) hang risk and
      # invoke the binary directly — same trade-off rustup makes.
      _probe_cmd=""
      if command -v timeout >/dev/null 2>&1; then
        _probe_cmd="timeout 2"
      elif command -v gtimeout >/dev/null 2>&1; then
        _probe_cmd="gtimeout 2"
      fi
      EXISTING_VERSION="$($_probe_cmd "$EXISTING_APPSTRATE" --version 2>/dev/null | head -n 1 || echo "?")"
      err "Another \`appstrate\` is already on PATH at:"
      err "    $EXISTING_APPSTRATE  (version: $EXISTING_VERSION)"
      err ""
      err "Installing to:"
      err "    $DEST"
      err ""
      err "Two binaries on PATH will silently shadow each other and \`appstrate"
      err "self-update\` only manages the curl-channel one. Pick a single channel:"
      err "  • Stay on the existing install: abort this bootstrap and run"
      err "    its native upgrade command (\`bun update -g appstrate\`, etc)."
      err "  • Switch to curl: remove the existing binary, then re-run."
      err "  • Force-install both anyway: APPSTRATE_FORCE_DUAL=1 (not recommended)."
      err ""
      err "See https://github.com/appstrate/appstrate/issues/249"

      # Determine interactive vs. non-interactive. `[ -t 0 ]` checks stdin;
      # when piped from `curl | bash`, stdin is the pipe (NOT a TTY) so we
      # also try to open /dev/tty for the prompt — same trick rustup uses.
      _ci_flag="${CI:-}"
      _is_ci=0
      case "$_ci_flag" in true | 1 | yes) _is_ci=1 ;; esac

      if [ "$_is_ci" = "1" ]; then
        err ""
        err "CI detected — refusing to prompt. Re-run with APPSTRATE_FORCE_DUAL=1"
        err "if you really want both binaries on this runner."
        exit 1
      fi

      _tty=""
      if [ -t 0 ]; then
        _tty="stdin"
      elif [ -r /dev/tty ]; then
        _tty="/dev/tty"
      fi

      if [ -z "$_tty" ]; then
        err ""
        err "Non-interactive shell detected — refusing to prompt."
        err "Re-run with APPSTRATE_FORCE_DUAL=1 if intentional."
        exit 1
      fi

      printf '\n'
      printf 'Continue and install the curl-channel binary alongside the existing one? [y/N] '
      ANSWER=""
      if [ "$_tty" = "/dev/tty" ]; then
        IFS= read -r ANSWER </dev/tty || ANSWER=""
      else
        IFS= read -r ANSWER || ANSWER=""
      fi
      case "$ANSWER" in
        y | Y | yes | YES) : ;; # proceed
        *)
          err ""
          err "Aborted — no files were written."
          exit 1
          ;;
      esac
      warn "Proceeding with dual-install at user request."
    fi
  elif [ "${APPSTRATE_FORCE_DUAL:-0}" = "1" ] && [ -n "$EXISTING_APPSTRATE" ]; then
    # User explicitly opted in. Surface the warning so they don't forget.
    warn "APPSTRATE_FORCE_DUAL=1 set — installing alongside existing $EXISTING_APPSTRATE"
  fi

  # ─── Download + verify ──────────────────────────────────────────────────────

  log "Downloading Appstrate CLI ($OS/$ARCH, $VERSION)"
  curl -fsSL "$URL" -o "$TMPDIR/$ASSET"

  if [ "${APPSTRATE_SKIP_VERIFY:-0}" = "1" ]; then
    # Hard-gate the skip on CI=true. The flag exists ONLY for CI debug
    # of the verification path itself; in any other context (interactive
    # shell, social-engineered paste-bin) bypassing the signature +
    # checksum gate is a security regression. Refuse loudly instead of
    # warning — a warning on a user machine is exactly the failure mode
    # this gate is designed to prevent.
    if [ "${CI:-}" != "true" ]; then
      err "APPSTRATE_SKIP_VERIFY=1 requires CI=true. Refusing to skip verification"
      err "  on an interactive / user machine — this flag exists only for CI debug."
      err "  If this is a CI run, export CI=true. Otherwise install minisign:"
      err "    → macOS:   brew install minisign"
      err "    → Debian:  sudo apt install minisign"
      err "    → Alpine:  apk add minisign"
      exit 1
    fi
    warn "APPSTRATE_SKIP_VERIFY=1 + CI=true — integrity + provenance checks skipped."
    warn "Only use this in controlled CI debug runs. Do NOT set on user machines."
    # Deliberate 5-second pause so a sysadmin auditing a paste-bin install
    # script has a visible window to Ctrl-C before execution. A silent warn
    # on stderr is trivially lost in terminal noise; `rustup-init` uses the
    # same pattern. Non-interactive contexts (no TTY) still pause — the
    # whole point is to slow down unattended piping into `| bash`.
    warn "Proceeding in 5 seconds. Press Ctrl-C to abort."
    sleep 5
  else
    # Verification is gated on minisign availability. Without it we can't
    # cryptographically tie the binary to the Appstrate release key; just
    # matching a checksum file downloaded over the same TLS channel as the
    # binary is security theatre (an on-path attacker can rewrite both).
    # Fail closed — the one-line install command the user just executed
    # took < 5s; installing minisign via the OS package manager costs
    # roughly the same.
    if ! have_minisign; then
      # Decide between auto-install vs. prompt vs. fail-with-hint. We treat
      # the same four signals that drive the launch decision below as
      # "unattended": --yes arg, APPSTRATE_AUTO_INSTALL=1, CI=true|1|yes,
      # and "no TTY on stdout". This keeps `curl … | bash -s -- --yes`
      # truly one-step and prevents the prompt from firing in Dockerfile
      # RUN, cron, or systemd contexts where there's nobody to answer.
      _ms_wants_auto=0
      case " $* " in *" --yes "*) _ms_wants_auto=1 ;; esac
      if [ "${APPSTRATE_AUTO_INSTALL:-0}" = "1" ]; then _ms_wants_auto=1; fi
      case "${CI:-}" in true | 1 | yes) _ms_wants_auto=1 ;; esac
      if [ ! -t 1 ]; then _ms_wants_auto=1; fi

      if [ "${APPSTRATE_NO_INSTALL_MINISIGN:-0}" = "1" ]; then
        _ms_installer=""
      else
        _ms_installer="$(detect_minisign_installer || true)"
      fi

      _ms_should_install=0
      if [ -n "$_ms_installer" ]; then
        if [ "$_ms_wants_auto" = "1" ]; then
          _ms_should_install=1
        else
          # Interactive prompt — fall back to /dev/tty if stdin is the
          # curl pipe (same trick as the dual-install gate above).
          _ms_tty=""
          if [ -t 0 ]; then
            _ms_tty="stdin"
          elif [ -r /dev/tty ]; then
            _ms_tty="/dev/tty"
          fi
          if [ -n "$_ms_tty" ]; then
            warn "minisign is required to verify the Appstrate CLI download."
            printf '\nInstall it now via %s? [Y/n] ' "$_ms_installer"
            _ms_answer=""
            if [ "$_ms_tty" = "/dev/tty" ]; then
              IFS= read -r _ms_answer </dev/tty || _ms_answer=""
            else
              IFS= read -r _ms_answer || _ms_answer=""
            fi
            case "$_ms_answer" in
              "" | y | Y | yes | YES) _ms_should_install=1 ;;
              *) _ms_should_install=0 ;;
            esac
          fi
        fi
      fi

      if [ "$_ms_should_install" = "1" ]; then
        if ! try_install_minisign; then
          err ""
          err "Could not auto-install minisign. Install it manually and re-run:"
          err "  → macOS:   brew install minisign"
          err "  → Debian:  sudo apt install minisign"
          err "  → Alpine:  apk add minisign"
          err "  → Other:   https://jedisct1.github.io/minisign/"
          exit 1
        fi
      else
        err "minisign is required to verify the Appstrate CLI download."
        err "  → macOS:   brew install minisign"
        err "  → Debian:  sudo apt install minisign"
        err "  → Alpine:  apk add minisign"
        err "  → Other:   https://jedisct1.github.io/minisign/"
        err ""
        err "To override (NOT recommended, only for CI debug), re-run with"
        err "  APPSTRATE_SKIP_VERIFY=1 curl -fsSL https://get.appstrate.dev | bash"
        exit 1
      fi
    fi

    log "Fetching release checksums + signature"
    curl -fsSL "$CHECKSUMS_URL" -o "$TMPDIR/checksums.txt"
    curl -fsSL "$CHECKSUMS_SIG_URL" -o "$TMPDIR/checksums.txt.minisig"

    log "Verifying signature against Appstrate release key"
    if ! minisign -Vm "$TMPDIR/checksums.txt" -P "$APPSTRATE_MINISIGN_PUBKEY" >/dev/null; then
      err "Signature verification FAILED."
      err "  → The checksums manifest was NOT signed by the Appstrate key."
      err "  → Your download is possibly tampered — do NOT execute."
      err "  → Report: https://github.com/appstrate/appstrate/issues"
      exit 1
    fi

    log "Verifying binary integrity (SHA-256)"
    # Prefer the GNU tool when available; fall back to BSD `shasum -c`
    # (default on macOS without coreutils). Both speak the same `<hash>
    # <filename>` line format so `checksums.txt` is compatible.
    (
      cd "$TMPDIR"
      # Only the line for our asset matters — filtering keeps the tool
      # from failing on missing sibling binaries we didn't download.
      # The `|| true` lets us own the empty-result error path below
      # instead of dying inside `grep` with a generic exit 1.
      grep " ${ASSET}\$" checksums.txt >checksums.local.txt || true
      # CRITICAL: `sha256sum -c` on an empty manifest exits 0 silently
      # ("0 lines processed, 0 failures"), which would let an attacker
      # bypass integrity by publishing a checksums.txt that's validly
      # signed but missing our asset line (broken release matrix, asset-
      # rename typo, or targeted tampering). Assert the line exists, and
      # belt-and-braces assert it's the ONLY line for our asset (catches
      # accidental duplicate entries that could mask a real mismatch).
      if [ ! -s checksums.local.txt ]; then
        err "Asset ${ASSET} is not listed in the signed checksums manifest."
        err "  → This is either a broken release or tampering — do NOT execute."
        err "  → Report: https://github.com/appstrate/appstrate/issues"
        exit 1
      fi
      lines=$(wc -l <checksums.local.txt)
      if [ "$lines" -ne 1 ]; then
        err "Expected exactly one line for ${ASSET} in checksums.txt, got ${lines}."
        err "  → Duplicate or malformed entries — do NOT execute."
        exit 1
      fi
      if have_sha256sum; then
        sha256sum -c --quiet checksums.local.txt
      elif have_shasum; then
        shasum -a 256 -c --quiet checksums.local.txt
      else
        err "Neither sha256sum nor shasum is available on this system."
        exit 1
      fi
    ) || {
      err "SHA-256 mismatch — the downloaded binary does NOT match the signed manifest."
      err "  → This strongly suggests tampering in transit. Do NOT execute."
      err "  → Report: https://github.com/appstrate/appstrate/issues"
      exit 1
    }
    log "Integrity + provenance verified"
  fi

  # ─── Install ────────────────────────────────────────────────────────────────

  # Create BIN_DIR if it doesn't exist — ~/.local/bin isn't present by
  # default on macOS vanilla. mkdir -p is a no-op if the dir already exists.
  # We attempt this unconditionally under the current user; if BIN_DIR lives
  # under a system path that requires root (explicit APPSTRATE_BIN_DIR
  # override), the mkdir will silently fail and we'll catch it in the
  # writability check below.
  mkdir -p "$BIN_DIR" 2>/dev/null || true

  # `sudo` only if the destination isn't user-writable — skips a pointless
  # auth prompt on the rootless default ($HOME/.local/bin), and on
  # /usr/local/bin setups where the dir is already user-owned (macOS Homebrew
  # under /opt/homebrew + symlinked /usr/local/bin). Only the explicit
  # APPSTRATE_BIN_DIR=/usr/local/bin override on a stock Linux/macOS system
  # will trigger the sudo prompt.
  SUDO=""
  if [ ! -w "$BIN_DIR" ]; then
    SUDO="sudo"
  fi

  log "Installing to $DEST"
  $SUDO install -m 0755 "$TMPDIR/$ASSET" "$DEST"

  # ─── PATH setup ─────────────────────────────────────────────────────────────

  # Add BIN_DIR to PATH by appending `export PATH="$BIN_DIR:$PATH"` to the
  # user's shell rc files. Same pattern as uv, rustup, Bun, Deno.
  #
  # Skipped when:
  #   - APPSTRATE_NO_MODIFY_PATH=1 (explicit opt-out, like UV_NO_MODIFY_PATH)
  #   - CI is truthy: 1/true/yes (covers GHA, GitLab, CircleCI, Travis,
  #     Jenkins and anything else that exports a boolean-ish CI flag —
  #     CIs don't restart shells; they set PATH explicitly)
  #   - BIN_DIR is already on PATH (common for /usr/local/bin — no-op needed)
  #
  # Idempotent: a marker comment (APPSTRATE_PATH_MARKER) is grep'd before
  # appending, so re-running the installer doesn't duplicate lines.
  APPSTRATE_PATH_MARKER="# added by appstrate installer"
  # Newline-separated list of rc files we touched. Accumulated (not
  # overwritten) so the final restart-your-shell hint reports every file,
  # not just the last one — critical for the bash shotgun case where up
  # to three files may be modified in a single run.
  MODIFIED_PROFILES=""
  _ci_flag="${CI:-}"
  if [ "${APPSTRATE_NO_MODIFY_PATH:-0}" = "1" ] ||
    [ "$_ci_flag" = "true" ] || [ "$_ci_flag" = "1" ] || [ "$_ci_flag" = "yes" ]; then
    : # explicit opt-out
  else
    case ":${PATH}:" in
      *":${BIN_DIR}:"*) : ;; # already on PATH, nothing to do
      *)
        _shell_name=$(basename "${SHELL:-}")
        # The exact export line written to POSIX rc files. The `$PATH` ref
        # is escaped (`\$PATH`) so it expands at shell-startup time, not
        # now — the rc file stays portable if the user ever moves $HOME.
        # (The fish branch below doesn't use this line; it writes a
        # fish-native `fish_add_path` invocation instead, which resolves
        # BIN_DIR eagerly — acceptable because fish re-evaluates conf.d
        # on every shell start and $HOME rewrites are vanishingly rare.)
        _path_line="export PATH=\"${BIN_DIR}:\$PATH\""

        # Append `$marker` + `$line` to `$file` if the marker isn't already
        # present. Touches the file if it doesn't exist (uv shotgun pattern).
        _append_path() {
          _file="$1"
          _line="$2"
          if [ -f "$_file" ] && grep -qF "$APPSTRATE_PATH_MARKER" "$_file" 2>/dev/null; then
            return 0
          fi
          # `>> "$file"` creates the file if absent — matches uv's behavior
          # of writing .profile/.zshrc even on fresh systems.
          printf '\n%s\n%s\n' "$APPSTRATE_PATH_MARKER" "$_line" >>"$_file"
          MODIFIED_PROFILES="${MODIFIED_PROFILES}${_file}
"
        }

        case "$_shell_name" in
          bash)
            # Shotgun approach — bash's rc-file loading varies wildly
            # (interactive vs login, macOS vs Linux, with/without
            # .bash_profile). Writing to all common candidates covers every
            # case without needing to introspect the invocation context.
            # .profile is included for POSIX sh / dash fallback.
            _append_path "$HOME/.profile" "$_path_line"
            _append_path "$HOME/.bashrc" "$_path_line"
            _append_path "$HOME/.bash_profile" "$_path_line"
            ;;
          zsh)
            # zsh loads .zshrc (interactive), .zprofile (login), and
            # .zshenv (all invocations). .zshrc + .zprofile are written
            # unconditionally — between them they cover every interactive
            # zsh session on macOS (default login shell) and Linux.
            # .zshenv is only touched if already present, to avoid
            # polluting non-interactive environments for users who
            # haven't opted in.
            _append_path "$HOME/.zshrc" "$_path_line"
            _append_path "$HOME/.zprofile" "$_path_line"
            if [ -f "$HOME/.zshenv" ]; then
              _append_path "$HOME/.zshenv" "$_path_line"
            fi
            ;;
          fish)
            # fish has its own syntax and a dedicated drop-in directory for
            # environment config — cleaner than touching config.fish
            # directly, and removable by deleting a single file.
            _fish_conf="$HOME/.config/fish/conf.d"
            mkdir -p "$_fish_conf" 2>/dev/null || true
            _append_path "$_fish_conf/appstrate.fish" "fish_add_path ${BIN_DIR}"
            ;;
          *)
            # Unknown shell — fall back to .profile (sourced by sh/dash and
            # some bash login configurations). Better than silently doing
            # nothing: at least the next login shell will pick it up.
            _append_path "$HOME/.profile" "$_path_line"
            ;;
        esac
        ;;
    esac
  fi

  if [ -n "$MODIFIED_PROFILES" ]; then
    # Informational output (not a warning — the action succeeded). Uses
    # `log` rather than `warn` so users don't mistake it for an error,
    # and lists every touched file so the shotgun bash case doesn't hide
    # the .profile / .bashrc writes behind the last one.
    log "Added ${BIN_DIR} to PATH in:"
    # Trim trailing newline so the loop doesn't emit a blank entry.
    printf '%s' "$MODIFIED_PROFILES" | while IFS= read -r _profile; do
      [ -n "$_profile" ] && log "  - ${_profile}"
    done
    log "Restart your shell to pick up the new PATH."
  fi

  # ─── Launch decision (#344 + #199 sidestep) ────────────────────────────────
  #
  # Two-step is the new default: drop the verified binary on PATH, print
  # a copy-pasteable next step, exit 0. The user's interactive shell
  # launches `appstrate install` from a real TTY where clack's
  # `setRawMode` works — the Bun macOS keypress/kqueue regressions (#199,
  # oven-sh/bun #6862, #7033, #24615, #5240, #14483, #18239) are bypassed
  # by construction because no prompt fires inside this shell-piped child
  # process and no `</dev/tty` redirect chains a kqueue EINVAL into later
  # subprocesses (`bun run dev`, `docker compose up`).
  #
  # Auto-install (legacy all-in-one behaviour) fires on four signals,
  # ordered cheapest → broadest:
  #   1. user passed `--yes` (CI / scripted automation, explicit intent)
  #   2. APPSTRATE_AUTO_INSTALL=1 (Ansible / cloud-init escape hatch —
  #      preserves the previous default for existing IaC)
  #   3. CI=true|1|yes (GHA, GitLab, CircleCI, Jenkins — any env that
  #      sets the canonical CI flag is by definition non-interactive)
  #   4. stdout is not a TTY (Dockerfile RUN, systemd unit, cron,
  #      `bash /tmp/inst.sh > out.log`). The user wouldn't see the
  #      next-step instruction anyway; running `--yes` is friendlier
  #      than dropping the binary and silently exiting.
  #
  # On the auto path, the CLI's `resolveBootstrapEmail` ships a
  # bootstrap token (closed-by-default) when no
  # `APPSTRATE_BOOTSTRAP_OWNER_EMAIL` is set — no more silently-public
  # VPS (#344 Layer 2b). The operator claims ownership at `<URL>/claim`
  # with the printed token.
  #
  # Pre-existing escape hatch preserved:
  #   - APPSTRATE_NO_LAUNCH=1 → drop binary, no install at all (scripted
  #     provisioning where install is owned by Ansible / cloud-init).
  _wants_auto=0
  case " $* " in *" --yes "*) _wants_auto=1 ;; esac
  if [ "${APPSTRATE_AUTO_INSTALL:-0}" = "1" ]; then _wants_auto=1; fi
  case "${CI:-}" in true | 1 | yes) _wants_auto=1 ;; esac
  if [ ! -t 1 ]; then _wants_auto=1; fi

  if [ "${APPSTRATE_NO_LAUNCH:-0}" = "1" ]; then
    log "APPSTRATE_NO_LAUNCH=1: skipping install entirely. Binary at $DEST."
    exit 0
  fi

  if [ "$_wants_auto" = "0" ]; then
    # New default: drop & instruct.
    printf '\n'
    log "Appstrate CLI installed."
    log ""
    log "To complete setup, run:"
    printf '\n    \033[1;36m%s install\033[0m\n\n' "$DEST"
    log "Or in a new shell (PATH already updated):"
    printf '\n    \033[1;36mappstrate install\033[0m\n\n'
    log "For unattended/CI installs: re-run with \`-s -- --yes\`."
    log "  Closed-by-default semantics ship a bootstrap token; see"
    log "  https://github.com/appstrate/appstrate/issues/344"
    exit 0
  fi

  log "Launching \`appstrate install --yes\` (unattended mode)"
  # Exec by absolute path, NOT by `appstrate` on PATH. A different binary
  # earlier in PATH (dev machine with `bun link`, stale /usr/local/bin
  # shadowed by ~/.local/bin) would silently shadow the verified one —
  # defeating the trust chain. `$DEST` is the exact file we wrote + chmod'd.
  exec "$DEST" install --yes "$@"

}

# Deliberate: guard against partial `curl | bash` execution by only
# invoking the function after the full file has been parsed. A truncated
# download dies with a shell syntax error on the unclosed function body
# or the missing invocation line, never with a half-run install.
_appstrate_bootstrap "$@"
