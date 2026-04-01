// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Development setup script — gets you from clone to running in one command.
 *
 * Usage: bun run setup
 *
 * Steps:
 *   1. Verify prerequisites (Docker, node_modules)
 *   2. Copy .env.example → .env (if .env doesn't exist)
 *   3. Start dev infrastructure (docker compose)
 *   4. Wait for all services to be ready
 *   5. Run database migrations
 *   6. Build frontend + shared packages
 */

const { existsSync } = await import("node:fs");
const { cp } = await import("node:fs/promises");
const { execSync } = await import("node:child_process");

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CHECK = `${GREEN}✓${RESET}`;

const root = import.meta.dir + "/..";

function run(cmd: string, label: string, hint?: string) {
  process.stdout.write(`  ${label}...`);
  try {
    execSync(cmd, { stdio: "pipe", cwd: root });
    console.log(` ${CHECK}`);
  } catch (e: unknown) {
    console.log(` ${RED}✗${RESET}`);
    const err = e as { stderr?: Buffer };
    if (err.stderr) {
      const stderr = err.stderr.toString().trim();
      if (stderr) console.error(`    ${DIM}${stderr.split("\n")[0]}${RESET}`);
    }
    if (hint) console.error(`    ${YELLOW}→ ${hint}${RESET}`);
    process.exit(1);
  }
}

function waitFor(label: string, check: string, maxRetries: number, hint: string) {
  process.stdout.write(`  ${label}...`);
  for (let i = 0; i < maxRetries; i++) {
    try {
      execSync(check, { stdio: "pipe", cwd: root });
      console.log(` ${CHECK}`);
      return;
    } catch {
      if (i === maxRetries - 1) {
        console.log(` ${RED}✗${RESET} (timeout)`);
        console.error(`    ${YELLOW}→ ${hint}${RESET}`);
        process.exit(1);
      }
      Bun.sleepSync(1000);
    }
  }
}

console.log(`\n${BOLD}Appstrate — Development Setup${RESET}\n`);

// ── Step 1: Prerequisites ─────────────────────────────────────

try {
  execSync("docker info", { stdio: "pipe" });
  console.log(`  ${CHECK} Docker is running`);
} catch {
  console.error(`  ${RED}✗${RESET} Docker is not running.`);
  console.error(`    ${YELLOW}→ Start Docker Desktop and retry.${RESET}`);
  process.exit(1);
}

if (!existsSync(root + "/node_modules")) {
  run("bun install", "Installing dependencies", "Run: bun install");
} else {
  console.log(`  ${CHECK} Dependencies installed`);
}

// ── Step 2: .env ──────────────────────────────────────────────

const envPath = root + "/.env";
const envExamplePath = root + "/.env.example";

if (existsSync(envPath)) {
  console.log(`  ${CHECK} .env already exists`);
} else {
  if (!existsSync(envExamplePath)) {
    console.error(`  ${RED}✗${RESET} .env.example not found.`);
    console.error(`    ${YELLOW}→ Ensure you're in the appstrate directory.${RESET}`);
    process.exit(1);
  }
  await cp(envExamplePath, envPath);
  console.log(`  ${CHECK} .env created from .env.example ${DIM}(dev-ready defaults)${RESET}`);
}

// ── Step 2b: Link local @appstrate/core (optional) ───────────

const coreDir = root + "/../core";
if (existsSync(coreDir + "/package.json")) {
  try {
    execSync("bun link", { stdio: "pipe", cwd: coreDir });
    execSync("bun link @appstrate/core", { stdio: "pipe", cwd: root });
    console.log(`  ${CHECK} @appstrate/core linked from ../core ${DIM}(local dev)${RESET}`);
  } catch {
    console.log(`  ${DIM}  ⊘ @appstrate/core local linking skipped (using npm version)${RESET}`);
  }
} else {
  console.log(`  ${DIM}  ⊘ ../core not found — using npm @appstrate/core${RESET}`);
}

// ── Step 3: Docker infrastructure ─────────────────────────────

console.log("");
run(
  "docker compose -f docker-compose.dev.yml up -d",
  "Starting infrastructure",
  "Check docker compose logs: docker compose -f docker-compose.dev.yml logs",
);

// ── Step 4: Wait for services ─────────────────────────────────

waitFor(
  "Waiting for PostgreSQL",
  "docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U appstrate",
  30,
  "Check: docker compose -f docker-compose.dev.yml logs postgres",
);

waitFor(
  "Waiting for Redis",
  "docker compose -f docker-compose.dev.yml exec -T redis redis-cli ping",
  15,
  "Check: docker compose -f docker-compose.dev.yml logs redis",
);

waitFor(
  "Waiting for MinIO",
  "docker compose -f docker-compose.dev.yml exec -T minio mc ready local",
  15,
  "Check: docker compose -f docker-compose.dev.yml logs minio",
);

// ── Step 5: Database migrations ───────────────────────────────

console.log("");
run("bun run db:migrate", "Running database migrations", "Check DATABASE_URL in .env");

// ── Step 6: Build ─────────────────────────────────────────────

run("bun run build", "Building frontend + shared packages", "Run: bun run build");

// ── Done ──────────────────────────────────────────────────────

console.log(`
${GREEN}${BOLD}Setup complete!${RESET}

  Start the platform:

    ${CYAN}bun run dev${RESET}

  Then open ${CYAN}http://localhost:3000${RESET} and create your first account.

  ${BOLD}Useful commands:${RESET}
    bun run dev              Start API + frontend (hot-reload)
    bun run check            TypeScript + ESLint + Prettier + OpenAPI
    bun test                 Run all tests (requires Docker)
    bun run build-runtime    Build agent image (only if you modify runtime-pi/)
    bun run build-sidecar    Build sidecar image (only if you modify runtime-pi/sidecar/)
`);
