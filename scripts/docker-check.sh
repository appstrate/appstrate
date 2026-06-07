#!/usr/bin/env bash
# ============================================================================
# Docker build smoke test — catches CI failures before tagging.
#
# Validates:
#   1. .dockerignore doesn't exclude files needed by Dockerfile COPY
#   2. All workspace node_modules are created in deps stage
#   3. Full image builds (deps → build → runtime)
#   4. Runtime resolves every shipped workspace package + their external deps
#
# The workspace list (step 2) and the runtime-resolution set (step 4) are
# DERIVED from the workspace graph (root package.json `workspaces` globs +
# per-package manifests + the Dockerfile's node_modules allowlist) rather than
# hand-maintained here — so a newly added package is auto-exercised.
#
# Usage: bash scripts/docker-check.sh
# ============================================================================

set -euo pipefail

# The Dockerfile uses `COPY --parents` (BuildKit-only). Force BuildKit on so the
# build doesn't fall back to the classic builder on Docker <23 or with an
# inherited DOCKER_BUILDKIT=0.
export DOCKER_BUILDKIT=1

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
ERRORS=0

fail() { echo -e "${RED}FAIL${NC}: $1"; ERRORS=$((ERRORS + 1)); }
pass() { echo -e "${GREEN}OK${NC}: $1"; }

echo "==> [1/4] Checking .dockerignore vs Dockerfile COPY..."

# Extract all COPY sources from Dockerfile (non-stage copies)
COPY_SOURCES=$(grep -E '^COPY [^-]' Dockerfile | grep -v '\-\-from=' | awk '{print $2}' | sort -u)

for src in $COPY_SOURCES; do
  # Skip glob patterns and multi-word sources
  [[ "$src" == *"*"* ]] && continue
  [[ "$src" == "." ]] && continue

  # Check if .dockerignore would exclude this file
  if docker build --check -f /dev/null . 2>/dev/null; then true; fi

  # Simple check: if the source exists locally but is in .dockerignore
  if [ -e "$src" ]; then
    # Use docker build context simulation
    if grep -qxF "$src" .dockerignore 2>/dev/null || grep -qxF "${src%/}" .dockerignore 2>/dev/null; then
      fail "$src is in .dockerignore but used in Dockerfile COPY"
    fi
  fi
done
pass ".dockerignore check done"

echo ""
echo "==> [2/4] Building deps stage + checking workspace node_modules..."

docker build --no-cache --target deps -t appstrate-docker-check-deps . -q > /dev/null 2>&1

# Enumerate workspace members from the root package.json `workspaces` globs
# (Bun built-ins only — no node_modules needed to run this). Deriving the list
# instead of hardcoding it means a newly added package is checked automatically.
WORKSPACES=$(bun -e '
  import { readFileSync, existsSync } from "fs";
  import { Glob } from "bun";
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const out = new Set();
  for (const g of root.workspaces) {
    if (g.includes("*")) {
      for (const m of new Glob(g + "/package.json").scanSync(".")) out.add(m.replace(/\/package\.json$/, ""));
    } else if (existsSync(g + "/package.json")) {
      out.add(g);
    }
  }
  process.stdout.write([...out].sort().join(" "));
')

for ws in $WORKSPACES; do
  # Skip workspaces with no dependencies (no node_modules expected)
  if ! grep -q '"dependencies"' "$ws/package.json" 2>/dev/null; then
    pass "$ws has no deps (skip)"
    continue
  fi
  if docker run --rm appstrate-docker-check-deps sh -c "[ -d '$ws/node_modules' ]" 2>/dev/null; then
    pass "$ws/node_modules exists"
  else
    fail "$ws/node_modules MISSING in deps stage"
  fi
done

echo ""
echo "==> [3/4] Full image build (deps → build → runtime)..."

if docker build --no-cache -t appstrate-docker-check . -q > /dev/null 2>&1; then
  pass "Docker image built successfully"
else
  fail "Docker image build failed"
  echo ""
  echo "Re-running with output for debugging:"
  docker build --no-cache -t appstrate-docker-check . 2>&1 | tail -20
fi

echo ""
echo "==> [4/4] Runtime import resolution check..."

# Graph-derived — replaces the old hand-maintained RUNTIME_IMPORTS list with two
# complementary, auto-extending assertions:
#
#  (a) SELF: every @appstrate workspace package whose `src` + manifest ship via
#      the Dockerfile `packages/*/src` glob (+ apps/api). Asserts the package
#      itself resolves, so a NEW package dropped under packages/ is exercised
#      with zero edits here.
#
#  (b) EXTDEP: every package whose node_modules is COPYed into the runtime image
#      (parsed from the Dockerfile's allowlist) that declares a non-@appstrate
#      dependency. Resolves the package AND one real external dep scoped to the
#      package directory — proving its node_modules actually shipped, not just
#      its src. The old check only resolved @appstrate subpaths and never touched
#      the external deps that motivate the allowlist, so a silently-omitted
#      node_modules slipped through GREEN.
#
# Limitation: a brand-new package picked up by the `packages/*` glob whose
# node_modules entry is FORGOTTEN in the Dockerfile allowlist is covered for
# src-resolution by (a), but its missing external deps are only caught here when
# they don't hoist to the root node_modules. Keep the glob + node_modules
# allowlist in sync (see the note above the allowlist in the Dockerfile).
RUNTIME_SELF=$(bun -e '
  import { readFileSync } from "fs";
  import { Glob } from "bun";
  const names = new Set();
  for (const m of new Glob("packages/*/package.json").scanSync(".")) {
    const pj = JSON.parse(readFileSync(m, "utf8"));
    if (pj.name && pj.name.startsWith("@appstrate/")) names.add(pj.name);
  }
  names.add(JSON.parse(readFileSync("apps/api/package.json", "utf8")).name);
  process.stdout.write([...names].sort().join(" "));
')

RUNTIME_EXTDEP=$(bun -e '
  import { readFileSync } from "fs";
  const df = readFileSync("Dockerfile", "utf8");
  const dirs = [...df.matchAll(/^COPY --from=\S+ \/app\/(\S+?)\/node_modules\b/gm)].map((m) => m[1]);
  const out = [];
  for (const d of [...new Set(dirs)]) {
    let pj;
    try { pj = JSON.parse(readFileSync(d + "/package.json", "utf8")); } catch { continue; }
    const ext = Object.keys(pj.dependencies || {}).filter((x) => !x.startsWith("@appstrate/"));
    if (ext.length) out.push(pj.name + "|" + d + "|" + ext[0]);
  }
  process.stdout.write(out.join(" "));
')

for name in $RUNTIME_SELF; do
  if docker run --rm appstrate-docker-check bun -e "require.resolve('$name/package.json')" > /dev/null 2>&1; then
    pass "package '$name' resolves"
  else
    fail "package '$name' CANNOT be resolved at runtime"
  fi
done

for entry in $RUNTIME_EXTDEP; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  dir="${rest%%|*}"
  dep="${rest##*|}"
  if docker run --rm appstrate-docker-check bun -e "const p=require('path');const base=p.dirname(require.resolve('$name/package.json'));require.resolve('$dep',{paths:[base]})" > /dev/null 2>&1; then
    pass "external dep '$dep' resolves for '$name' ($dir)"
  else
    fail "external dep '$dep' for '$name' MISSING — node_modules likely omitted from runtime image"
  fi
done

echo ""
echo "==> Cleaning up..."
docker rmi appstrate-docker-check-deps appstrate-docker-check > /dev/null 2>&1 || true

echo ""
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}ALL CHECKS PASSED${NC}"
else
  echo -e "${RED}$ERRORS CHECK(S) FAILED${NC}"
  exit 1
fi
