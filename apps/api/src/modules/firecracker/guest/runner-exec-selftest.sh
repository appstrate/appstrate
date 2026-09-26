#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Build-time self-test of appstrate-runner-exec, the guest's only setuid
# binary. Dockerfile.rootfs runs it as root in the wrapper stage, so a
# mismatch fails the image build: every refused uid must exit 2, and a drop
# must land exactly on the pool user's credentials with no inherited fd.
#
#   runner-exec-selftest.sh <path-to-appstrate-runner-exec>
set -eu

bin=$1
fail() {
  echo "runner-exec self-test: $*" >&2
  exit 1
}

addgroup -g 1003 workspace
addgroup -g 1100 runner0
adduser -D -u 1100 -G runner0 -s /sbin/nologin runner0
chmod 700 /home/runner0
# A pool uid whose primary group is not its private one (1101 has no entry).
adduser -D -u 1102 -G runner0 -s /sbin/nologin notprivate

for uid in 0 1099 1164 abc +1100 '' 1101 1102; do
  "$bin" "$uid" /bin/true 2>/dev/null && code=0 || code=$?
  [ "$code" -eq 2 ] || fail "uid '$uid' exited $code, want 2"
done

# Runs as the dropped runner. `[` is an ash builtin, so /proc/self/fd is
# the exec'd shell's own table.
probe=$(
  cat <<'EOF'
umask
echo "$HOME"
awk '/^(Uid|Gid|Groups|NoNewPrivs):/ { $1 = $1; print }' /proc/self/status
if [ -e /proc/self/fd/7 ]; then echo fd7-open; else echo fd7-closed; fi
EOF
)
base='0007
/home/runner0
Uid: 1100 1100 1100 1100
Gid: 1100 1100 1100 1100'

# An fd the caller leaked without CLOEXEC, which the wrapper must close.
exec 7</etc/passwd
[ -e /proc/self/fd/7 ] || fail "could not open fd 7 in the test shell"

out=$("$bin" 1100 sh -c "$probe") || fail "drop exited $?"
want="$base
Groups:
NoNewPrivs: 1
fd7-closed"
[ "$out" = "$want" ] || fail "drop without --workspace: got
$out
want
$want"

out=$("$bin" --workspace 1100 sh -c "$probe") || fail "--workspace drop exited $?"
want="$base
Groups: 1003
NoNewPrivs: 1
fd7-closed"
[ "$out" = "$want" ] || fail "drop with --workspace: got
$out
want
$want"

echo "runner-exec self-test: ok"
