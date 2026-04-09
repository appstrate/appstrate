// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Development setup script — gets you from clone to running in one command.
 *
 * Usage:
 *   bun run setup           # Interactive tier selection
 *   bun run setup -- --tier 0   # Zero-install (no Docker)
 *   bun run setup -- --tier 3   # Full stack (Docker + all services)
 *
 * Infrastructure Tiers:
 *   0 — Zero-Install: PGlite + filesystem + in-memory (no Docker)
 *   1 — Minimal: PostgreSQL (Docker)
 *   2 — Standard: PostgreSQL + Redis (Docker)
 *   3 — Full: PostgreSQL + Redis + MinIO + Docker execution
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

// ── Tier selection ───────────────────────────────────────────

const TIER_NAMES = ["Zero-Install", "Minimal", "Standard", "Full"] as const;
const TIER_DESC = [
  "PGlite + filesystem + in-memory (no Docker needed)",
  "PostgreSQL (Docker)",
  "PostgreSQL + Redis (Docker)",
  "PostgreSQL + Redis + MinIO + Docker execution",
];

async function selectTier(): Promise<number> {
  // Check --tier CLI argument
  const tierArg = process.argv.find((a) => a.startsWith("--tier"));
  if (tierArg) {
    const val = tierArg.includes("=")
      ? tierArg.split("=")[1]
      : process.argv[process.argv.indexOf(tierArg) + 1];
    const n = parseInt(val ?? "", 10);
    if (n >= 0 && n <= 3) return n;
  }

  console.log(`  ${BOLD}Choose your infrastructure tier:${RESET}\n`);
  for (let i = 0; i <= 3; i++) {
    const marker = i === 0 ? ` ${GREEN}(recommended)${RESET}` : "";
    console.log(`    ${BOLD}${i}${RESET} — ${TIER_NAMES[i]}${marker}`);
    console.log(`        ${DIM}${TIER_DESC[i]}${RESET}`);
  }

  process.stdout.write(`\n  Tier [0]: `);
  const input = await new Promise<string>((resolve) => {
    const buf: number[] = [];
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });

  const n = input === "" ? 0 : parseInt(input, 10);
  if (n >= 0 && n <= 3) return n;
  console.error(`  ${RED}Invalid tier. Defaulting to 0.${RESET}`);
  return 0;
}

console.log(`\n${BOLD}Appstrate — Development Setup${RESET}\n`);

const tier = await selectTier();
console.log(`\n  ${CHECK} Tier ${tier}: ${TIER_NAMES[tier]}\n`);

// ── Step 1: Prerequisites ─────────────────────────────────────

if (tier > 0) {
  try {
    execSync("docker info", { stdio: "pipe" });
    console.log(`  ${CHECK} Docker is running`);
  } catch {
    console.error(`  ${RED}✗${RESET} Docker is not running (required for Tier ${tier}).`);
    console.error(
      `    ${YELLOW}→ Start Docker Desktop and retry, or use Tier 0 (no Docker).${RESET}`,
    );
    process.exit(1);
  }
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
    process.exit(1);
  }
  await cp(envExamplePath, envPath);
  console.log(`  ${CHECK} .env created from .env.example`);
}

// ── Step 3: Docker infrastructure (Tier 1+) ──────────────────

if (tier === 0) {
  console.log(`\n  ${DIM}Skipping Docker (Tier 0 — zero-install)${RESET}`);
} else {
  const profileMap = ["", "minimal", "standard", "full"];
  const profile = profileMap[tier]!;

  console.log("");
  run(
    `docker compose -f docker-compose.dev.yml --profile ${profile} up -d`,
    `Starting infrastructure (${profile})`,
    "Check: docker compose -f docker-compose.dev.yml logs",
  );

  // ── Step 4: Wait for services ────────────────────────────

  waitFor(
    "Waiting for PostgreSQL",
    "docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U appstrate",
    30,
    "Check: docker compose -f docker-compose.dev.yml logs postgres",
  );

  if (tier >= 2) {
    waitFor(
      "Waiting for Redis",
      "docker compose -f docker-compose.dev.yml exec -T redis redis-cli ping",
      15,
      "Check: docker compose -f docker-compose.dev.yml logs redis",
    );
  }

  if (tier >= 3) {
    waitFor(
      "Waiting for MinIO",
      "docker compose -f docker-compose.dev.yml exec -T minio mc ready local",
      15,
      "Check: docker compose -f docker-compose.dev.yml logs minio",
    );
  }

  // ── Step 5: Database migrations ────────────────────────────

  console.log("");
  run("bun run db:migrate", "Running database migrations", "Check DATABASE_URL in .env");
}

// ── Step 6: Build ─────────────────────────────────────────────

console.log("");
run("bun run build", "Building frontend + shared packages", "Run: bun run build");

// ── Done ──────────────────────────────────────────────────────

const envHint =
  tier === 0
    ? `${DIM}(Tier 0 — PGlite embedded, no .env changes needed)${RESET}`
    : `${DIM}(Tier ${tier} — uncomment DATABASE_URL${tier >= 2 ? " + REDIS_URL" : ""}${tier >= 3 ? " + S3_BUCKET" : ""} in .env)${RESET}`;

console.log(`
${GREEN}${BOLD}Setup complete!${RESET} ${envHint}

  Start the platform:

    ${CYAN}bun run dev${RESET}

  Then open ${CYAN}http://localhost:3000${RESET} and create your first account.

  ${BOLD}Useful commands:${RESET}
    bun run dev              Start API + frontend (hot-reload)
    bun run check            TypeScript + ESLint + Prettier + OpenAPI
    bun test                 Run all tests
    bun run docker:dev       Start Tier 3 Docker infrastructure
`);
