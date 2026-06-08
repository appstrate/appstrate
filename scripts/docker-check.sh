#!/usr/bin/env bash
# ============================================================================
# Docker build smoke test — catches CI failures before tagging.
#
# Validates:
#   1. .dockerignore doesn't exclude files needed by Dockerfile COPY
#   2. All workspace node_modules are created in deps stage
#   3. Full image builds (deps → build → runtime)
#   4. Runtime resolves every shipped workspace package, the FULL apps/api
#      entrypoint module graph, and the external deps behind the COPY allowlist
#
# The workspace list (step 2) and the runtime-resolution set (step 4) are
# DERIVED from the workspace graph (root package.json `workspaces` globs +
# per-package manifests + the Dockerfile's node_modules allowlist + a real
# `bun build` of the entrypoint) rather than hand-maintained here — so a newly
# added package is auto-exercised.
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

  # Check if the source exists locally but is excluded by .dockerignore
  if [ -e "$src" ]; then
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

# Graph-derived — replaces the old hand-maintained RUNTIME_IMPORTS list with
# three complementary, auto-extending assertions:
#
#  (a) SELF: every @appstrate workspace package whose `src` + manifest ship via
#      the Dockerfile `packages/*/src` glob (+ apps/api). Asserts the package
#      itself resolves, so a NEW package dropped under packages/ is exercised
#      with zero edits here.
#
#  (b) GRAPH: a real `bun build` of the apps/api entrypoint INSIDE the runtime
#      image. Bun statically walks the entire VALUE-import module graph (2000+
#      modules) and fails with "Could not resolve: <dep>" if ANY reachable
#      import is missing. This is the robust catch for the afps-shared class:
#      a package value-imported at runtime whose node_modules was FORGOTTEN from
#      the Dockerfile allowlist no longer slips through GREEN — bun build names
#      the unresolved dep and the importing file. Because `import type` edges are
#      erased before resolution, packages that ship as inert src but are never
#      value-loaded (e.g. ui, mcp-transport reached only via `import type`) are
#      correctly NOT required — so this stays free of false positives while a
#      naive package.json closure would wrongly demand their node_modules.
#
#  (c) EXTDEP: every package whose node_modules is COPYed into the runtime image
#      (parsed from the Dockerfile allowlist) that declares non-@appstrate deps.
#      Resolves EVERY external dep with `paths:[<pkg dir>]` — the package's own
#      directory taken straight from the parsed COPY line (NOT via a brittle
#      `require.resolve("@scope/name")`, which only works for the few packages
#      symlinked at the root node_modules). `require.resolve` walks UP from there,
#      so for a dep hoisted to the root tree this only proves the ROOT
#      node_modules shipped; for an isolated/non-hoisted dep it proves the
#      package's OWN node_modules shipped. Completeness against forgotten
#      packages is guaranteed by (b), not here — (c) is a targeted
#      per-allowlist-entry cross-check.
#
# The EXTDEP allowlist parse uses a flag-order-independent regex (BuildKit lets
# `--from`, `--chown`, `--link` appear in any order) and a drift guard that
# THROWS if the Dockerfile clearly has /app/<pkg>/node_modules COPY lines but
# the regex parsed zero — so a future regex regression can never masquerade as a
# vacuously-green run.
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

# Parse the runtime node_modules COPY allowlist. The path capture
# `/app/<pkg>/node_modules` is matched regardless of where `--from`/other flags
# sit on the COPY line; glob captures (the build-stage `--parents /app/./*`
# broad copies) and the root `/app/node_modules` are excluded.
RUNTIME_EXTDEP=$(bun -e '
  import { readFileSync } from "fs";
  const df = readFileSync("Dockerfile", "utf8");
  const noGlob = (d) => !d.includes("*");
  // Loose: any per-package node_modules COPY line (drift detector).
  const loose = [...df.matchAll(/^COPY\b[^\n]*?\/app\/(\S+?)\/node_modules\b/gm)].map((m) => m[1]).filter(noGlob);
  // Strict: stage copies only (must carry --from=), flag-order-independent.
  const dirs = [...new Set([...df.matchAll(/^COPY\b(?=[^\n]*--from=)[^\n]*?\/app\/(\S+?)\/node_modules\b/gm)].map((m) => m[1]).filter(noGlob))];
  if (loose.length > 0 && dirs.length === 0) {
    throw new Error("docker-check: Dockerfile has /app/<pkg>/node_modules COPY lines but the allowlist regex parsed ZERO dirs — regex drift; refusing to pass vacuously");
  }
  const out = [];
  for (const d of dirs) {
    let pj;
    try { pj = JSON.parse(readFileSync(d + "/package.json", "utf8")); } catch { continue; }
    const ext = Object.keys(pj.dependencies || {}).filter((x) => !x.startsWith("@appstrate/"));
    for (const dep of ext) out.push(pj.name + "|" + d + "|" + dep);
  }
  process.stdout.write(out.join(" "));
') || { fail "EXTDEP Dockerfile allowlist parse FAILED (see error above) — regex drift / coverage loss"; RUNTIME_EXTDEP=""; }

# (a) SELF — each shipped workspace package resolves at runtime.
for name in $RUNTIME_SELF; do
  if docker run --rm appstrate-docker-check bun -e "require.resolve('$name/package.json')" > /dev/null 2>&1; then
    pass "package '$name' resolves"
  else
    fail "package '$name' CANNOT be resolved at runtime"
  fi
done

# (b) GRAPH — the full apps/api entrypoint module graph resolves in the image.
if build_out=$(docker run --rm appstrate-docker-check sh -c 'cd /app && bun build apps/api/src/index.ts --target=bun --outfile=/tmp/docker-check-bundle.js' 2>&1); then
  pass "apps/api entrypoint module graph fully resolves in runtime image"
else
  fail "apps/api entrypoint has UNRESOLVED imports — a value-imported package's node_modules is missing from the Dockerfile allowlist"
  printf '%s\n' "$build_out" | grep -iE 'could not resolve|maybe you need|error:' | head -20 | sed 's/^/    /'
fi

# (c) EXTDEP — every external dep behind each allowlisted node_modules resolves.
# Batched into a single container run (one resolve loop) to avoid per-dep docker
# overhead; entries are space-separated `name|dir|dep` tuples (no embedded
# spaces), passed as argv.
if [ -n "$RUNTIME_EXTDEP" ]; then
  # shellcheck disable=SC2086
  extdep_out=$(docker run --rm appstrate-docker-check bun -e '
    const p = require("path");
    for (const e of process.argv.slice(1)) {
      const [name, dir, dep] = e.split("|");
      try {
        require.resolve(dep, { paths: [p.resolve(dir)] });
        console.log("OK|" + dep + "|" + name + "|" + dir);
      } catch {
        console.log("FAIL|" + dep + "|" + name + "|" + dir);
      }
    }
  ' $RUNTIME_EXTDEP 2>/dev/null)
  while IFS='|' read -r status dep name dir; do
    [ -z "$status" ] && continue
    if [ "$status" = "OK" ]; then
      pass "external dep '$dep' resolves for '$name' ($dir)"
    else
      fail "external dep '$dep' for '$name' MISSING — node_modules likely omitted from runtime image"
    fi
  done <<< "$extdep_out"
fi

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
