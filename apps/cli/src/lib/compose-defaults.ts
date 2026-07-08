// SPDX-License-Identifier: Apache-2.0

/**
 * Shared knowledge about env defaults that the self-hosting compose
 * files MUST NOT re-declare, plus the pure analysis + repair routines
 * that operate on a compose file's text.
 *
 * Two consumers:
 *   1. `scripts/verify-compose-defaults.ts` — PR-time guard that fails
 *      CI when a tracked compose template mirrors a code default (the
 *      #513 `MODULES` drift class).
 *   2. `apps/cli` — the runtime side (issue #515): `appstrate doctor`
 *      flags an operator's *on-disk* `docker-compose.yml` when it still
 *      carries stale duplicated defaults, and `appstrate install
 *      --upgrade-compose` surgically strips them.
 *
 * Keeping the table + extraction in one module means the CI guard and
 * the runtime check can never disagree about what counts as a
 * duplication.
 *
 * ─── Why a hand-maintained table (not parsed from the Zod schema) ────
 *
 * The schema's `.default(...)` calls in `packages/env/src/index.ts` are
 * interleaved with transforms and refinements that are non-trivial to
 * extract statically. A hand list paired with the CI guard's coverage
 * is enough to catch the regression — a typo in the table just fails to
 * catch one duplication, it never introduces one. Keep this list in
 * sync with `packages/env/src/index.ts` when adding new vars.
 */

/** Source-of-truth file the defaults mirror — referenced in messages. */
export const SCHEMA_SOURCE = "packages/env/src/index.ts";

// ─── Code defaults (mirror of `packages/env/src/index.ts`) ───────────
//
// String values are the literal default the Zod schema resolves to
// BEFORE transformation (compose passes raw env vars, the schema parses
// JSON / coerces booleans afterward). Keep this list in sync.
export const CODE_DEFAULTS: Record<string, string> = {
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
  OTEL_ENABLED: "false",
  OTEL_SERVICE_NAME: "appstrate-api",
  OTEL_TRUST_INCOMING_TRACE: "false",
  MODULES: "oidc,webhooks,mcp,core-providers,@appstrate/module-chat",
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
  // Sidecar integration runtime pinned by the Docker orchestrator
  // (operator override; the process orchestrator reads the raw env).
  INTEGRATION_RUNTIME_ADAPTER: "docker",
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
export const ALLOWLIST: Record<string, { yamlDefault: string; reason: string }> = {
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

export interface ComposeDefaultMatch {
  /** 1-based line number within the analyzed content. */
  line: number;
  varName: string;
  /** The `default` captured from `${NAME:-default}`. */
  yamlDefault: string;
  /** The full source line the match was found on (verbatim). */
  raw: string;
}

// Match `${NAME:-default}` where default can be anything except `}`.
// The pattern handles nested braces poorly, but compose files don't
// use them — this is sufficient for the env vars we care about.
//
// Re-created per call (not a module-level singleton) so the stateful
// `lastIndex` of a `/g` regex can never leak between callers.
function defaultPattern(): RegExp {
  return /\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}/g;
}

/**
 * Extract every `${NAME:-default}` occurrence from a compose file's text.
 * Pure — takes the file content, returns one match per occurrence.
 */
export function extractComposeDefaults(content: string): ComposeDefaultMatch[] {
  const lines = content.split("\n");
  const matches: ComposeDefaultMatch[] = [];
  const pattern = defaultPattern();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(line)) !== null) {
      const [, varName, yamlDefault] = m;
      if (!varName) continue;
      matches.push({ line: i + 1, varName, yamlDefault: yamlDefault ?? "", raw: line });
    }
  }

  return matches;
}

// ─── Findings ────────────────────────────────────────────────────────

export interface ComposeDuplicateFinding {
  kind: "duplicate";
  line: number;
  varName: string;
  yamlDefault: string;
  codeDefault: string;
  raw: string;
}

export interface ComposeAllowlistDriftFinding {
  kind: "allowlist-drift";
  line: number;
  varName: string;
  yamlDefault: string;
  expectedYamlDefault: string;
  raw: string;
}

export type ComposeFinding = ComposeDuplicateFinding | ComposeAllowlistDriftFinding;

/**
 * Analyze a compose file's text against {@link CODE_DEFAULTS} /
 * {@link ALLOWLIST}. Returns findings in line order:
 *
 *   - `duplicate`       — a `${VAR:-x}` whose `x` equals the code default
 *                         (the #513 drift class — safe-but-stale, the
 *                         YAML value masks future schema changes).
 *   - `allowlist-drift` — an intentional override whose recorded
 *                         yamlDefault no longer matches the file.
 *
 * Pure: no filesystem, no globals. Callers (CI guard, doctor) wrap it.
 */
export function analyzeComposeDefaults(content: string): ComposeFinding[] {
  const findings: ComposeFinding[] = [];

  for (const match of extractComposeDefaults(content)) {
    const codeDefault = CODE_DEFAULTS[match.varName];
    if (codeDefault === undefined) continue; // not tracked, skip

    const allowed = ALLOWLIST[match.varName];
    if (allowed) {
      // Allowed — but sanity-check the recorded yamlDefault still
      // matches what the file actually says. Catch silent drift.
      if (allowed.yamlDefault !== match.yamlDefault) {
        findings.push({
          kind: "allowlist-drift",
          line: match.line,
          varName: match.varName,
          yamlDefault: match.yamlDefault,
          expectedYamlDefault: allowed.yamlDefault,
          raw: match.raw,
        });
      }
      continue;
    }

    if (match.yamlDefault === codeDefault) {
      findings.push({
        kind: "duplicate",
        line: match.line,
        varName: match.varName,
        yamlDefault: match.yamlDefault,
        codeDefault,
        raw: match.raw,
      });
    }
  }

  return findings;
}

// ─── In-place repair (`appstrate install --upgrade-compose`) ─────────

/** A duplicated-default line that was rewritten to a bare passthrough. */
export interface ComposeFixApplied {
  line: number;
  varName: string;
  before: string;
  after: string;
}

/** A finding that could not be auto-fixed — operator must act by hand. */
export interface ComposeFixRefused {
  line: number;
  varName: string;
  reason: string;
  raw: string;
}

export interface ComposeFixResult {
  /** True when at least one line was rewritten. */
  changed: boolean;
  /** The repaired file content (identical to input when `changed` is false). */
  newContent: string;
  applied: ComposeFixApplied[];
  refused: ComposeFixRefused[];
}

// A duplicated default in the shipped templates always lives as a YAML
// *sequence* entry — `      - VAR=${VAR:-default}`. The fix is to drop
// the `=${VAR:-default}` so the entry becomes a bare passthrough
// (`      - VAR`), letting the Zod schema's default win at boot. This
// regex is deliberately strict: it only matches that exact shape so we
// never mangle a mapping entry, an inline-interpolation, or a line that
// also carries a trailing comment.
function listEntryPattern(varName: string): RegExp {
  const v = escapeRegExp(varName);
  return new RegExp(`^(\\s*-\\s*)${v}=\\$\\{${v}:-[^}]*\\}\\s*$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip stale duplicated env defaults from a compose file's text,
 * preserving every other line verbatim (operator-added services,
 * volumes, comments are untouched — the rewrite only ever shortens the
 * specific `- VAR=${VAR:-default}` lines that mirror a code default).
 *
 * `allowlist-drift` findings are intentionally LEFT ALONE: a divergent
 * intentional-override default may be the operator's own deliberate
 * choice, not the #513 bug — they surface in `appstrate doctor` for a
 * human to judge, but are never auto-edited here.
 *
 * Any duplicated-default occurrence that is NOT in the canonical
 * sequence-entry shape (a hand-written mapping form, or two defaults on
 * one line) is reported as `refused` rather than guessed at — the
 * caller prints it for manual follow-up.
 *
 * Pure + idempotent: re-running on the result yields zero changes.
 */
export function rewriteStaleComposeDefaults(content: string): ComposeFixResult {
  const findings = analyzeComposeDefaults(content);
  const duplicates = findings.filter((f): f is ComposeDuplicateFinding => f.kind === "duplicate");

  if (duplicates.length === 0) {
    return { changed: false, newContent: content, applied: [], refused: [] };
  }

  const lines = content.split("\n");
  const applied: ComposeFixApplied[] = [];
  const refused: ComposeFixRefused[] = [];

  for (const dup of duplicates) {
    const idx = dup.line - 1;
    const original = lines[idx];
    if (original === undefined) continue; // unreachable — line came from this content
    const m = listEntryPattern(dup.varName).exec(original);
    if (!m) {
      refused.push({
        line: dup.line,
        varName: dup.varName,
        reason:
          "duplicated default is not a bare `- VAR=${VAR:-default}` sequence entry " +
          "(mapping form, inline interpolation, or trailing comment) — edit by hand",
        raw: original,
      });
      continue;
    }
    const prefix = m[1] ?? "";
    const after = `${prefix}${dup.varName}`;
    lines[idx] = after;
    applied.push({ line: dup.line, varName: dup.varName, before: original, after });
  }

  return {
    changed: applied.length > 0,
    newContent: applied.length > 0 ? lines.join("\n") : content,
    applied,
    refused,
  };
}
