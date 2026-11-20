#!/usr/bin/env bash
# ============================================================================
# Docker build smoke test — catches CI failures before tagging.
#
# Validates:
#   1. .dockerignore doesn't exclude files needed by Dockerfile COPY
#   2. All workspace node_modules are created in deps stage
#   3. Full image builds (deps → build → runtime)
#   4. Shipped workspace manifests, sources, direct dependencies and API imports
#
# Usage: bun run docker:check (local pre-release diagnostic).
# CI exercises the built image separately in scripts/health-container-e2e.sh.
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

# Expand the expected manifests on the host so a missing workspace in the image
# is visible. Bun isolates dependencies under their declaring workspace. A
# package can expose only subpaths and keep its own package.json private.
if docker run --rm appstrate-docker-check bun -e '
  async function hasDependency(workspace, dependency) {
    const parts = workspace.split("/");
    for (;;) {
      const manifest = [...parts, "node_modules", dependency, "package.json"].join("/");
      if (await Bun.file(manifest).exists()) return true;
      if (!parts.length) return false;
      parts.pop();
    }
  }

  const manifests = process.argv.slice(1);
  let dependencies = 0;
  for (const manifest of manifests) {
    const workspace = manifest.slice(0, manifest.lastIndexOf("/"));
    const pkg = await Bun.file(manifest).json();
    if (!(await Bun.file(workspace + "/src").stat()).isDirectory()) {
      throw new Error("Missing workspace sources in " + workspace);
    }
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (!await hasDependency(workspace, dependency)) {
        throw new Error(pkg.name + " cannot find dependency " + dependency + " from " + workspace);
      }
      dependencies++;
    }
  }
  console.log(manifests.length + " workspaces and " + dependencies + " direct dependencies present");
' apps/api/package.json packages/*/package.json; then
  pass "shipped workspace manifests, sources and direct dependencies are present"
else
  fail "runtime workspace contents or dependencies are missing"
fi

# `--external kysely`: better-auth ships BOTH a kysely and a drizzle adapter; we
# use the drizzle adapter (packages/db/src/auth.ts), so kysely is never
# value-loaded at runtime — it is a lazy/optional peer. But `bun build` walks the
# static import graph eagerly and chokes on kysely's migrator named exports
# (`DEFAULT_MIGRATION_TABLE`, `DEFAULT_MIGRATION_LOCK_TABLE`) that don't exist in
# kysely@0.29's bundled `dist/index.js` — a bundler-only phantom error for code
# that never executes. Externalizing kysely keeps this probe honest for the deps
# we DO load while not asserting resolvability of a dead lazy adapter. If a
# future change genuinely value-imports kysely, drop this flag.
if build_out=$(docker run --rm appstrate-docker-check sh -c 'cd /app && bun build apps/api/src/index.ts --target=bun --external kysely --outfile=/tmp/docker-check-bundle.js' 2>&1); then
  pass "apps/api entrypoint module graph fully resolves in runtime image"
else
  fail "apps/api entrypoint has UNRESOLVED imports — check the runtime image for missing dependencies"
  printf '%s\n' "$build_out" | grep -iE 'could not resolve|maybe you need|error:' | head -20 | sed 's/^/    /'
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
