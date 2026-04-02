#!/usr/bin/env bash
# ============================================================================
# Docker build smoke test — catches CI failures before tagging.
#
# Validates:
#   1. .dockerignore doesn't exclude files needed by Dockerfile COPY
#   2. All workspace node_modules are created in deps stage
#   3. Full image builds (deps → build → runtime)
#   4. Runtime can resolve all workspace imports
#
# Usage: bash scripts/docker-check.sh
# ============================================================================

set -euo pipefail

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

WORKSPACES="packages/core packages/connect packages/db packages/emails packages/env packages/shared-types apps/api apps/web runtime-pi runtime-pi/sidecar"

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

# Check that all workspace packages can be resolved at runtime
RUNTIME_IMPORTS="@appstrate/core/validation @appstrate/core/logger @appstrate/db/schema @appstrate/db/client @appstrate/env @appstrate/connect @appstrate/emails @appstrate/shared-types"

for imp in $RUNTIME_IMPORTS; do
  if docker run --rm appstrate-docker-check bun -e "require.resolve('$imp')" > /dev/null 2>&1; then
    pass "import '$imp' resolves"
  else
    fail "import '$imp' CANNOT be resolved at runtime"
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
