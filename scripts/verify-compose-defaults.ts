// SPDX-License-Identifier: Apache-2.0

/**
 * Verify that compose files don't re-declare env defaults that are
 * already defined in `packages/env/src/index.ts` (the Zod schema).
 *
 * The duplication risk is real: see #513 (`MODULES` drifted in compose
 * from the schema, and every CLI self-host install shipped with zero
 * model providers for weeks). This guard catches the same class of bug
 * at PR time.
 *
 * Approach (intentionally simple): regex-parse the 4 compose files for
 * `${NAME:-DEFAULT}` patterns; cross-check each match against the
 * hand-maintained `CODE_DEFAULTS` table below. Flag any YAML default
 * that mirrors the code default, unless the variable is on the
 * `ALLOWLIST` (intentional override, with a documented reason).
 *
 * Trade-off: the table here is hand-maintained, not parsed from the
 * Zod schema. The schema's `.default(...)` calls are mixed with
 * transforms and refinements that are non-trivial to extract
 * statically, and a hand list paired with this same guard's coverage
 * is enough to catch the regression — a typo in the table would just
 * fail to catch one duplication, not introduce one. Keep the table in
 * sync with `packages/env/src/index.ts` when adding new vars.
 *
 * Usage: bun scripts/verify-compose-defaults.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const COMPOSE_FILES = [
  "examples/self-hosting/docker-compose.yml",
  "examples/self-hosting/docker-compose.tier1.yml",
  "examples/self-hosting/docker-compose.tier2.yml",
  "examples/self-hosting/docker-compose.tier3.yml",
];

const SCHEMA_SOURCE = "packages/env/src/index.ts";

// ─── Code defaults (mirror of `packages/env/src/index.ts`) ───────────
//
// String values are the literal default the Zod schema resolves to
// BEFORE transformation (compose passes raw env vars, the schema parses
// JSON / coerces booleans afterward). Keep this list in sync.
const CODE_DEFAULTS: Record<string, string> = {
  APP_URL: "http://localhost:3000",
  AUTH_DISABLE_SIGNUP: "false",
  AUTH_DISABLE_ORG_CREATION: "false",
  AUTH_PLATFORM_ADMIN_EMAILS: "",
  AUTH_ALLOWED_SIGNUP_DOMAINS: "",
  AUTH_BOOTSTRAP_OWNER_EMAIL: "",
  AUTH_BOOTSTRAP_ORG_NAME: "Default",
  AUTH_BOOTSTRAP_TOKEN: "",
  AFPS_TRUST_ROOT: "[]",
  AFPS_SIGNATURE_POLICY: "off",
  BETTER_AUTH_ACTIVE_KID: "k1",
  BETTER_AUTH_SECRETS: "{}",
  CONNECTION_ENCRYPTION_KEY_ID: "k1",
  CONNECTION_ENCRYPTION_KEYS: "{}",
  LOG_LEVEL: "info",
  MODULES: "oidc,webhooks,mcp,core-providers,@appstrate/module-codex,@appstrate/module-claude-code",
  OAUTH_REFRESH_WORKER_ENABLED: "false",
  INTEGRATION_REFRESH_MAX_FAILURES: "5",
  INTEGRATION_REFRESH_GRACE_SECONDS: "3600",
  REMOTE_RUN_SINK_DEFAULT_TTL_SECONDS: "7200",
  REMOTE_RUN_SINK_MAX_TTL_SECONDS: "86400",
  REMOTE_RUN_REPLAY_WINDOW_SECONDS: "600",
  REMOTE_RUN_BUFFER_FLUSH_MS: "5000",
  REMOTE_RUN_EVENT_LIMITS: "{}",
  RUN_HEARTBEAT_INTERVAL_SECONDS: "15",
  RUN_STALL_THRESHOLD_SECONDS: "60",
  RUN_WATCHDOG_INTERVAL_SECONDS: "15",
  SIDECAR_MAX_REQUEST_BODY_BYTES: "10485760",
  SIDECAR_MAX_MCP_ENVELOPE_BYTES: "16777216",
  SYSTEM_PROVIDER_KEYS: "[]",
  SYSTEM_PROXIES: "[]",
  TRUST_PROXY: "false",
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: "300",
  // `RUN_TOKEN_SECRET` is `.optional()` — its absence equals empty
  // string in compose, so a `${RUN_TOKEN_SECRET:-}` is a duplication.
  RUN_TOKEN_SECRET: "",
  // `PORT` default is the number 3000; compose stores strings.
  PORT: "3000",
  // `DOCKER_SOCKET` is a code default but compose mirrors the YAML
  // volume mount (intentional override territory — see ALLOWLIST).
  DOCKER_SOCKET: "/var/run/docker.sock",
  // `RUN_ADAPTER` code default is `process`; compose intentionally
  // overrides to `docker` (see ALLOWLIST).
  RUN_ADAPTER: "process",
  // `TRUSTED_ORIGINS` code default is the dev localhost CSV; compose
  // intentionally overrides to empty (see ALLOWLIST).
  TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:5173",
  // `PI_IMAGE` / `SIDECAR_IMAGE` code default is Docker Hub `:latest`;
  // compose intentionally overrides to GHCR (see ALLOWLIST).
  PI_IMAGE: "appstrate-pi:latest",
  SIDECAR_IMAGE: "appstrate-sidecar:latest",
  // `PGLITE_DATA_DIR` / `FS_STORAGE_PATH` defaults exist but compose
  // doesn't usually reference them with a default.
  PGLITE_DATA_DIR: "./data/pglite",
  FS_STORAGE_PATH: "./data/storage",
  // `NODE_ENV` defaults to `development`; compose-driven prod usually
  // sets it explicitly via `.env`, no default-mirroring expected.
  NODE_ENV: "development",
  API_BODY_LIMIT_BYTES: "10485760",
  SMTP_PORT: "587",
  LLM_PROXY_CACHE_MODE: "off",
  LLM_PROXY_CACHE_MAX_AGE: "3600",
  PLATFORM_RUN_LIMITS: "{}",
  INLINE_RUN_LIMITS: "{}",
  LLM_PROXY_LIMITS: "{}",
  CREDENTIAL_PROXY_LIMITS: "{}",
  OIDC_INSTANCE_CLIENTS: "[]",
};

// ─── Allowlist — intentional overrides (reason required) ─────────────
//
// Each entry's value is the YAML default and the operator-visible
// rationale for differing from the code default. When the YAML default
// CHANGES, update the rationale (or remove the entry if the override
// is no longer intentional).
const ALLOWLIST: Record<string, { yamlDefault: string; reason: string }> = {
  RUN_ADAPTER: {
    yamlDefault: "docker",
    reason:
      "Code default `process` is for OSS dev; containerized self-host requires Docker isolation.",
  },
  TRUSTED_ORIGINS: {
    yamlDefault: "",
    reason:
      "Code default includes dev localhost ports; prod self-host correctly defaults to empty so operator opts in to their public domain explicitly.",
  },
  S3_BUCKET: {
    yamlDefault: "appstrate",
    reason:
      "Environment-specific — switches the platform into S3 mode. Bare name aligns with the MinIO bucket created by minio-init.",
  },
  S3_REGION: {
    yamlDefault: "us-east-1",
    reason:
      "Environment-specific. MinIO ignores this but the AWS SDK requires it to be non-empty when S3_BUCKET is set.",
  },
  PORT: {
    yamlDefault: "3000",
    reason: "Mirrors the YAML `ports:` mapping — keep coupled.",
  },
  DOCKER_SOCKET: {
    yamlDefault: "/var/run/docker.sock",
    reason: "Mirrors the YAML `volumes:` mount — keep coupled.",
  },
  PI_IMAGE: {
    yamlDefault: "ghcr.io/appstrate/appstrate-pi:${APPSTRATE_VERSION:-latest}",
    reason:
      "Override to GHCR registry + APPSTRATE_VERSION coupling (code default points at Docker Hub).",
  },
  SIDECAR_IMAGE: {
    yamlDefault: "ghcr.io/appstrate/appstrate-sidecar:${APPSTRATE_VERSION:-latest}",
    reason:
      "Override to GHCR registry + APPSTRATE_VERSION coupling (code default points at Docker Hub).",
  },
  BETTER_AUTH_SECRETS: {
    yamlDefault: "",
    reason:
      "Empty string (NOT `{}`) is load-bearing — neutralizes better-auth 1.6+'s own CSV parser that crashes boot on a non-CSV `{}` value. See compose comment block.",
  },
};

// ─── Compose default extraction ──────────────────────────────────────

interface Match {
  file: string;
  line: number;
  varName: string;
  yamlDefault: string;
}

// Match `${NAME:-default}` where default can be anything except `}`.
// The pattern handles nested braces poorly, but compose files don't
// use them — this is sufficient for the env vars we care about.
const DEFAULT_PATTERN = /\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}/g;

function extractDefaults(filePath: string): Match[] {
  const absPath = join(REPO_ROOT, filePath);
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const matches: Match[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    DEFAULT_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEFAULT_PATTERN.exec(line)) !== null) {
      const [, varName, yamlDefault] = m;
      if (!varName) continue;
      matches.push({
        file: filePath,
        line: i + 1,
        varName,
        yamlDefault: yamlDefault ?? "",
      });
    }
  }

  return matches;
}

// ─── Main ────────────────────────────────────────────────────────────

type Finding =
  | {
      kind: "duplicate";
      file: string;
      line: number;
      varName: string;
      yamlDefault: string;
      codeDefault: string;
    }
  | {
      kind: "allowlist-drift";
      file: string;
      line: number;
      varName: string;
      yamlDefault: string;
      expectedYamlDefault: string;
    };

function main(): number {
  const findings: Finding[] = [];

  for (const file of COMPOSE_FILES) {
    for (const match of extractDefaults(file)) {
      const codeDefault = CODE_DEFAULTS[match.varName];
      if (codeDefault === undefined) continue; // not in our table, skip

      const allowed = ALLOWLIST[match.varName];
      if (allowed) {
        // Allowed — but sanity-check the recorded yamlDefault still
        // matches what the file actually says. Catch silent drift.
        if (allowed.yamlDefault !== match.yamlDefault) {
          findings.push({
            kind: "allowlist-drift",
            file: match.file,
            line: match.line,
            varName: match.varName,
            yamlDefault: match.yamlDefault,
            expectedYamlDefault: allowed.yamlDefault,
          });
        }
        continue;
      }

      if (match.yamlDefault === codeDefault) {
        findings.push({
          kind: "duplicate",
          file: match.file,
          line: match.line,
          varName: match.varName,
          yamlDefault: match.yamlDefault,
          codeDefault,
        });
      }
    }
  }

  if (findings.length === 0) {
    console.log(
      `\x1b[32m✓\x1b[0m verify-compose-defaults: no duplicated env defaults across ${COMPOSE_FILES.length} compose files.`,
    );
    return 0;
  }

  const duplicates = findings.filter((f) => f.kind === "duplicate");
  const drifts = findings.filter((f) => f.kind === "allowlist-drift");

  console.error(
    `\x1b[31m✗\x1b[0m verify-compose-defaults: ${findings.length} issue(s) found ` +
      `(${duplicates.length} duplicates, ${drifts.length} ALLOWLIST drift).\n`,
  );

  if (duplicates.length > 0) {
    console.error(`\x1b[1m── Class 1: duplicates code default ──\x1b[0m`);
    console.error(
      `Compose files should not mirror defaults already defined in ${SCHEMA_SOURCE}.\n` +
        `Drop the YAML default and rely on the Zod schema's single source of truth — or, if the\n` +
        `override is deliberate, add the variable to the ALLOWLIST in\n` +
        `scripts/verify-compose-defaults.ts with a documented reason.\n` +
        `This was the root cause of #513 (MODULES drift → no model providers).\n`,
    );
    for (const f of duplicates) {
      console.error(
        `  \x1b[1m${f.file}:${f.line}\x1b[0m  ${f.varName}=${JSON.stringify(f.yamlDefault)}`,
      );
      console.error(
        `    \x1b[33m[duplicates code default]\x1b[0m in ${SCHEMA_SOURCE} (${f.varName}: ${JSON.stringify(f.codeDefault)})`,
      );
    }
    console.error("");
  }

  if (drifts.length > 0) {
    console.error(`\x1b[1m── Class 2: ALLOWLIST drift ──\x1b[0m`);
    console.error(
      `The ALLOWLIST entry's recorded yamlDefault no longer matches the compose file.\n` +
        `Either update the ALLOWLIST entry in scripts/verify-compose-defaults.ts (when the\n` +
        `change is intentional — also revise the documented reason) or revert the compose\n` +
        `change. Silent drift would let an intentional override quietly change semantics.\n`,
    );
    for (const f of drifts) {
      console.error(
        `  \x1b[1m${f.file}:${f.line}\x1b[0m  ${f.varName}=${JSON.stringify(f.yamlDefault)}`,
      );
      console.error(
        `    \x1b[33m[ALLOWLIST drift]\x1b[0m expected yamlDefault=${JSON.stringify(f.expectedYamlDefault)} ` +
          `but compose file has ${JSON.stringify(f.yamlDefault)}`,
      );
    }
    console.error("");
  }

  return 1;
}

process.exit(main());
