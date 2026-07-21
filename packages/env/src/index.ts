// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { createEnvGetter } from "@appstrate/core/env";

// Boolean-from-string env transform: `"true"`/`"1"` (case-insensitive) → true,
// anything else → false. Shared by every on/off flag so the parse semantics
// stay identical across the schema.
const boolEnv = (defaultValue: "true" | "false") =>
  z
    .string()
    .default(defaultValue)
    .transform((s) => s.toLowerCase() === "true" || s === "1");

// JSON-from-string env transform: parses a JSON-valued env var, failing fast
// at boot with a clear Zod issue (path = the variable name) instead of a raw
// `SyntaxError` bubbling out of `getEnv()`. Empty string == unset (compose's
// `${VAR:-}` pattern) → falls back to the schema default so the parse always
// has valid JSON to work with. Callers pin the parsed shape via the type
// argument (the value is still validated loosely here; strict shape checks
// happen downstream in the API layer where each var is consumed).
const jsonEnv = <T>(defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((s, ctx): T => {
      const raw = s === "" ? defaultValue : s;
      try {
        return JSON.parse(raw) as T;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be valid JSON" });
        return z.NEVER;
      }
    });

// ─── Schema ──────────────────────────────────────────────────
//
// MAINTAINER NOTE: this Zod schema is the single source of truth for env
// defaults. When adding or changing a `.default(...)` value below, mirror
// the entry in `scripts/verify-compose-defaults.ts:CODE_DEFAULTS` so the
// compose-drift guard can still detect duplicated/stale YAML defaults
// (root cause of #513 — MODULES drifted in compose vs. schema, every CLI
// self-host shipped with zero model providers for weeks). The script's
// hand-maintained table is intentional: Zod defaults are entangled with
// transforms/refinements that don't extract cleanly via static analysis.

const envSchema = z
  .object({
    // Node environment — gates production-only invariants (e.g. APP_URL https)
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // Deployed build identity — stamped into the image at build time
    // (Dockerfile ARG → ENV, fed by the release workflow). Surfaced read-only
    // via /health and the SPA footer so operators can see which build is live.
    // Absent in dev/source runs → the UI falls back to "dev".
    APP_VERSION: z.string().optional(),
    // Short git SHA of the build commit (companion to APP_VERSION).
    GIT_SHA: z.string().optional(),
    // Trust proxy hops: "false" (default, ignore XFF) | "true" (=1) | "N" (N trusted hops)
    TRUST_PROXY: z
      .string()
      .default("false")
      .refine((v) => v === "false" || v === "true" || (/^\d+$/.test(v) && Number(v) >= 0), {
        message: "TRUST_PROXY must be 'false', 'true', or a non-negative integer",
      }),
    // Database (optional — falls back to PGlite embedded Postgres when absent)
    DATABASE_URL: z.string().optional(),
    // PGlite data directory (used when DATABASE_URL is absent)
    PGLITE_DATA_DIR: z.string().default("./data/pglite"),
    BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
    /**
     * Active key id for the auth-secret map. Cookies and HMACs WE sign
     * (e.g. `pending-client-cookie.ts`) include this kid so verifiers can
     * pick the right secret from `BETTER_AUTH_SECRETS` during rotation.
     */
    BETTER_AUTH_ACTIVE_KID: z
      .string()
      .default("k1")
      .refine((v) => /^[A-Za-z0-9_-]{1,32}$/.test(v), {
        message: "BETTER_AUTH_ACTIVE_KID must match /^[A-Za-z0-9_-]{1,32}$/",
      }),
    /**
     * JSON map of `{ kid: secret }` enumerating every secret a verifier
     * should accept. Empty object (default) means "use BETTER_AUTH_SECRET
     * under BETTER_AUTH_ACTIVE_KID" — fully backward compatible.
     *
     * Rotation pattern (online, no forced sign-out for cookies WE sign):
     *   1. Add the new secret to BETTER_AUTH_SECRETS under a fresh kid.
     *   2. Flip BETTER_AUTH_ACTIVE_KID to the fresh kid + restart.
     *   3. Wait out the longest cookie TTL (10 min for pending-client).
     *   4. Drop the old kid from BETTER_AUTH_SECRETS + restart.
     *
     * The Better Auth session cookie is signed with the active secret only;
     * Better Auth itself does not (yet) accept a verification list, so
     * rotating the session cookie still requires re-login.
     */
    BETTER_AUTH_SECRETS: z
      .string()
      .default("{}")
      .transform((s, ctx) => {
        // Empty string == unset (compose `${VAR:-}` defaults to ""); fall back
        // to "{}" so the JSON parse below succeeds.
        const raw = s === "" ? "{}" : s;
        try {
          const parsed = JSON.parse(raw) as unknown;
          // ── Namespace-collision scrub ─────────────────────────────────────
          // better-auth 1.6+ ships its own `BETTER_AUTH_SECRETS` env var with
          // a different format (CSV `v1:secret,v2:secret`). It is read
          // unconditionally inside `betterAuth()` regardless of whether we
          // pass an explicit `secret:` option, so a non-CSV value (incl. our
          // JSON `{}` default) crashes boot with `BetterAuthError: Invalid
          // BETTER_AUTH_SECRETS entry`. We never want better-auth's own
          // multi-secret rotation feature — `auth.ts` always passes `secret`
          // explicitly via `env.BETTER_AUTH_SECRETS[…] ?? BETTER_AUTH_SECRET`
          // — so unconditionally remove the raw env so better-auth falls back
          // to its legacy single-secret path.
          delete process.env.BETTER_AUTH_SECRETS;
          return parsed;
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "BETTER_AUTH_SECRETS must be valid JSON",
          });
          return z.NEVER;
        }
      })
      .pipe(z.record(z.string(), z.string())),
    // Dedicated HMAC secret for FS upload-sink tokens. Separate from
    // BETTER_AUTH_SECRET so the two can be rotated independently and a
    // compromise of one does not affect the other.
    //
    // Comma-separated keyring for online rotation (single value = keyring of
    // one): the FIRST key signs new tokens, ALL keys verify, so rotation does
    // not invalidate in-flight upload URLs. Rotation pattern: prepend the new
    // key + restart, wait out the longest token TTL, drop the old key +
    // restart. Each key must be ≥16 chars (and thus comma-free).
    UPLOAD_SIGNING_SECRET: z
      .string()
      .min(1, "UPLOAD_SIGNING_SECRET is required")
      .refine((v) => v.split(",").every((k) => k.length >= 16), {
        message: "UPLOAD_SIGNING_SECRET: each comma-separated key must be at least 16 chars",
      }),
    // Dedicated HMAC secret for hosted-connect-portal session tokens (issue
    // #769) — short-lived capability tokens that gate the unified integration
    // connect flow. Required: the hosted portal is the primary UI surface for
    // connecting integrations, so a deployment without this secret would boot
    // "successfully" with its main connect button dead (issue #905). The
    // installer generates it, upgrades backfill it via `mergeEnv`, and the
    // self-hosting compose templates loud-fail without it. Same comma-separated
    // keyring rotation as the upload secret; each key ≥16 chars. Keep separate
    // from BETTER_AUTH_SECRET / the upload secret so each can rotate
    // independently.
    CONNECT_SESSION_SECRET: z
      .string()
      .min(1, "CONNECT_SESSION_SECRET is required")
      .refine((v) => v.split(",").every((k) => k.length >= 16), {
        message: "CONNECT_SESSION_SECRET: each comma-separated key must be at least 16 chars",
      }),
    // TTL for hosted-connect-portal session tokens, in milliseconds. Short by
    // design — a connect token is a one-shot capability, not a session.
    CONNECT_SESSION_TTL_MS: z.coerce.number().int().positive().default(600_000),
    // S3 storage (optional — falls back to filesystem when S3_BUCKET is absent)
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    // Public-facing S3 endpoint used only for presigned URLs served to browsers.
    // Falls back to S3_ENDPOINT when unset. Set this when S3_ENDPOINT points at
    // an internal Docker hostname unreachable from the browser (e.g. MinIO).
    S3_PUBLIC_ENDPOINT: z.string().optional(),
    // Filesystem storage path (used when S3_BUCKET is absent)
    FS_STORAGE_PATH: z.string().default("./data/storage"),

    // Connect
    CONNECTION_ENCRYPTION_KEY: z
      .string()
      .min(1, "CONNECTION_ENCRYPTION_KEY is required")
      .refine((val) => Buffer.from(val, "base64").length === 32, {
        message: "CONNECTION_ENCRYPTION_KEY must be 32 bytes (256-bit) base64-encoded",
      }),
    // Active key id embedded in newly-encrypted credential blobs (v1 envelope).
    // Stable across deploys — change only when promoting a freshly-rotated key.
    // Must match /^[A-Za-z0-9_-]{1,32}$/.
    CONNECTION_ENCRYPTION_KEY_ID: z
      .string()
      .default("k1")
      .refine((v) => /^[A-Za-z0-9_-]{1,32}$/.test(v), {
        message: "CONNECTION_ENCRYPTION_KEY_ID must match /^[A-Za-z0-9_-]{1,32}$/",
      }),
    // Retired keys held for decrypt-only during a rotation window. JSON map of
    // kid → base64-encoded 32-byte key. Exclude the active kid (validated at boot).
    // Empty map disables the retired keyring.
    //
    // Validated as `Record<string, string>` AT BOOT — a non-string value or
    // JSON parse error fails fast with a clear Zod issue path, rather than
    // surfacing inside `loadKeyring()` as a `Buffer.from(b64, "base64")`
    // length mismatch hours later. The kid format itself is validated by
    // `loadKeyring()` against the same `KID_PATTERN` used for envelopes.
    CONNECTION_ENCRYPTION_KEYS: z
      .string()
      .default("{}")
      .transform((s, ctx) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "CONNECTION_ENCRYPTION_KEYS must be valid JSON",
          });
          return z.NEVER;
        }
      })
      .pipe(z.record(z.string(), z.string())),
    SYSTEM_PROXIES: jsonEnv<unknown[]>("[]"),
    SYSTEM_PROVIDER_KEYS: jsonEnv<unknown[]>("[]"),
    // System-level integrations offered by the deployment out of the box.
    // Membership = the "auto-active" policy (on by default until an org opts
    // out). Each entry MAY ship one or more shared OAuth clients
    // (client_id/secret) for its auths — the standard SaaS connector pattern
    // (e.g. the Appstrate-verified Google app) so every org connects without
    // registering its own OAuth app — or NO clients, for remote MCP
    // integrations that use Dynamic Client Registration (no static client).
    // Shape: [{ id, clients?: [{ id, auth_key, client_id, client_secret? }] }].
    // JSON array; validated + indexed by `integration-client-registry.ts` at
    // boot. Mirrors SYSTEM_PROVIDER_KEYS. An org that registers its own per-app
    // client (BYO-app) overrides the system client; the minting client is
    // pinned per connection so refresh resolves the right credentials.
    SYSTEM_INTEGRATIONS: jsonEnv<unknown[]>("[]"),

    // OIDC instance clients — declarative provisioning of satellite OAuth
    // clients (admin dashboards, second-party web apps). Parsed loosely
    // here; the oidc module applies a strict Zod schema at boot. See
    // `apps/api/src/modules/oidc/services/instance-client-sync.ts`.
    OIDC_INSTANCE_CLIENTS: jsonEnv<unknown[]>("[]"),

    // Platform-wide run limits (applied to EVERY run — classic + inline).
    // Empty object means defaults apply. Validated strictly inside the API
    // layer (apps/api/src/services/run-limits.ts); defaults are designed to
    // be non-breaking for existing deployments.
    PLATFORM_RUN_LIMITS: jsonEnv<Record<string, unknown>>("{}"),

    // Inline-run specific limits (caps on manifest size, skills/tools count,
    // authorized URIs, retention). See docs/specs/INLINE_RUNS.md §6.
    INLINE_RUN_LIMITS: jsonEnv<Record<string, unknown>>("{}"),

    // LLM proxy limits — caps on `/api/llm-proxy/*` (per-call rate, body size).
    // Empty object means defaults apply. Validated strictly at boot via
    // `apps/api/src/services/proxy-limits.ts`; unknown keys fail-fast.
    LLM_PROXY_LIMITS: jsonEnv<Record<string, unknown>>("{}"),

    // Credential proxy limits — caps on `/api/credential-proxy/proxy`
    // (per-call rate, request/response body size, cookie-jar TTL). Same
    // strict-Zod validation as LLM_PROXY_LIMITS.
    CREDENTIAL_PROXY_LIMITS: jsonEnv<Record<string, unknown>>("{}"),

    // Unified runner protocol — governs the event-ingestion surface shared
    // by platform containers and remote CLIs. See
    // docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md.
    //
    // Default sink TTL when the caller does not request one (remote CLI) or
    // cannot (platform container boot env). 2h is comfortably above the
    // platform timeout ceiling.
    REMOTE_RUN_SINK_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(7200),
    // Hard ceiling — any caller-requested TTL is clamped to this.
    REMOTE_RUN_SINK_MAX_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
    // Per-run event-route rate limit. Parsed at route-build time, changes
    // require a reboot. Empty object means defaults apply.
    REMOTE_RUN_EVENT_LIMITS: jsonEnv<Record<string, unknown>>("{}"),
    // Redis dedup window for webhook-id replay detection. MUST exceed the
    // Standard Webhooks timestamp tolerance (5 min) so a replayed event
    // cannot slip through after its cache entry expires.
    REMOTE_RUN_REPLAY_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
    // Out-of-order event buffer flush window. Events with non-contiguous
    // sequence numbers wait up to this long for the gap to fill; terminal
    // events (run.success/failed/timeout/cancelled) flush immediately
    // regardless of gaps.
    REMOTE_RUN_BUFFER_FLUSH_MS: z.coerce.number().int().positive().default(5000),
    // Fallback DB-poll cadence for `GET /runs/:id?wait=` long-polls — the
    // safety net when the realtime NOTIFY path doesn't deliver. Tuning
    // knob only; the test preload shrinks it to 50ms so route tests don't
    // pay a real 2s tick per wakeup.
    RUN_WAIT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

    // Standard Webhooks `webhook-timestamp` tolerance window (seconds).
    // Inbound run-event signatures with a timestamp drifting more than
    // this from the server clock are rejected. The Standard Webhooks
    // recommendation is 5 minutes (300s) — exposed here so hardened-clock
    // environments can tighten and lossy CI receivers can loosen.
    //
    // Default 300s; floor enforced by the runtime verifier (`verify()`
    // in `@appstrate/afps-runtime/events`). Must stay strictly less than
    // REMOTE_RUN_REPLAY_WINDOW_SECONDS or a replayed event could slip
    // past the dedup cache between expiries.
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

    // Runner liveness — the stall watchdog and the runner-side keep-alive
    // form a single unified detection path across every runner topology
    // (platform container, remote CLI, GitHub Action, …). See
    // apps/api/src/services/run-watchdog.ts.
    //
    // Runner emits an implicit heartbeat on every event POST plus an
    // explicit /sink/extend on idle; the watchdog sweeps any open-sink
    // row whose last heartbeat slipped past STALL_THRESHOLD.
    //
    // The watchdog is the *backstop* — cooperative shutdown (Ctrl-C /
    // SIGTERM in the CLI, container exit synthesis on the platform)
    // sends an explicit finalize POST so the run terminates instantly.
    // The threshold only matters for hard crashes (kill -9, OOM,
    // network partition) where the runner can never speak again. 60s
    // strikes a compromise: short enough that the user notices quickly,
    // long enough that a single dropped heartbeat doesn't trip the wire.
    //
    // Ratio rule-of-thumb: stall_threshold ≥ 3 × heartbeat_interval
    // (industry consensus: Temporal, Sidekiq, BullMQ, AWS Builders'
    // Library) so a single dropped ping never trips the watchdog. Current
    // defaults: 60 / 15 = 4×.
    RUN_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
    RUN_STALL_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(60),
    RUN_WATCHDOG_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),

    // OAuth Model Provider refresh worker — proactively refreshes credentials
    // whose access_token is within the lead window so the next agent run
    // doesn't pay a 401-retry on the hot path. Off by default: the sidecar's
    // on-demand token-resolver + 401 retry path covers correctness on its
    // own. Operators who care about (a) keeping refresh_tokens alive across
    // long dormant windows and (b) shifting refresh latency off the hot path
    // can opt in. Disabling drops 280+ lines of BullMQ scan/refresh worker
    // wiring from a running instance.
    OAUTH_REFRESH_WORKER_ENABLED: boolEnv("false"),

    // Integration connection refresh-failure escalation. When an OAuth token
    // refresh fails *transiently* (not `invalid_grant`) this many times in a
    // row AND the token is already expired past the grace window below, the
    // connection is flipped to `needsReconnection` so the run preflight catches
    // it early with an actionable "reconnect" cause instead of every scheduled
    // run dying opaquely at integration boot. The expiry gate prevents a
    // temporary upstream outage on a still-valid token from bricking the
    // connection — escalation requires the token to be genuinely dead.
    INTEGRATION_REFRESH_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    INTEGRATION_REFRESH_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(3600),

    // Modules (comma-separated specifiers). API-key LLM calls are routed
    // directly to the upstream provider — retry is handled by the Pi SDK
    // natively (Retry-After honoring + jitter). The default set is the
    // built-in OSS modules ONLY. The two reference OAuth-subscription modules
    // — `@appstrate/module-codex` (ChatGPT/Codex) and
    // `@appstrate/module-claude-code` (Claude Pro/Max/Team) — are OPT-IN: a
    // personal subscription powering a product is an operator-owned grey-zone
    // (see docs/architecture/SUBSCRIPTION_COMPLIANCE.md), so the OSS default
    // ships neither. Append them to enable subscription providers.
    // `MODULES=none` boots with zero modules (the only sentinel — `""`
    // coalesces to unset, i.e. the default set, per the compose `${VAR:-}`
    // pattern).
    MODULES: z.string().default("oidc,webhooks,mcp,core-providers,@appstrate/module-chat"),

    // App
    APP_URL: z.string().default("http://localhost:3000"),
    TRUSTED_ORIGINS: z
      .string()
      .default("http://localhost:3000,http://localhost:5173")
      .transform((s) =>
        s
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * `/api/llm-proxy/*` response cache mode. Opt-in — default `off` keeps
     * every API-key call hitting upstream verbatim.
     *
     *   - `off`     — cache layer skipped entirely.
     *   - `simple`  — exact-match request hashing; cache hit on byte-
     *                 identical body. Backed by Redis when `REDIS_URL` is
     *                 set, in-memory per-process otherwise.
     */
    LLM_PROXY_CACHE_MODE: z.enum(["off", "simple"]).default("off"),
    /**
     * Per-entry TTL (seconds) for cached `/api/llm-proxy/*` responses
     * when `LLM_PROXY_CACHE_MODE !== "off"`. Default 3600 (1h). Ignored
     * when cache is off.
     */
    LLM_PROXY_CACHE_MAX_AGE: z.coerce.number().int().nonnegative().default(3600),
    // Global request body size cap enforced by the Hono `bodyLimit` middleware.
    // Per-route caps (LLM proxy, signed-token upload sink) still apply on top.
    API_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    COOKIE_DOMAIN: z.string().optional(),
    DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
    // Empty string → undefined so downstream `??` fallbacks (and the sidecar
    // platform-network auto-detection) kick in when the var is forwarded empty
    // by Docker Compose / Coolify.
    PLATFORM_API_URL: z
      .string()
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // Run — execution backend id resolved against the orchestrator registry
    // at boot. Core provides "docker" (isolated containers) and "process"
    // (default, Bun subprocesses, no isolation); modules can contribute more
    // (e.g. the built-in `firecracker` module — one microVM per run, see
    // docs/architecture/FIRECRACKER.md). Kept as an open string: the value
    // is validated after modules load, where an unknown id is a fatal boot
    // error listing the registered backends.
    RUN_ADAPTER: z.string().default("process"),

    // Integration runtime backend the Docker orchestrator pins onto the
    // sidecar (operator override; same value set as core RUN_ADAPTER
    // backends). The process orchestrator deliberately reads the raw
    // environment instead — it must distinguish "unset" (pin to "process")
    // from an explicit operator override, which a schema default would
    // erase. The firecracker orchestrator always pins "process": the
    // sidecar runs INSIDE the guest, so its integration runners are guest
    // subprocesses.
    INTEGRATION_RUNTIME_ADAPTER: z.enum(["docker", "process"]).default("docker"),

    // Docker images (override for GHCR / custom registries)
    PI_IMAGE: z.string().default("appstrate-pi:latest"),
    SIDECAR_IMAGE: z.string().default("appstrate-sidecar:latest"),

    // Per-run workspace volume init image. A minimal image (~5 MB) used
    // once per run to chown the freshly created Docker volume to UID
    // 1001 (the agent's `pi` user). Override only if your environment
    // can't pull from Docker Hub or you want a pre-baked busybox.
    WORKSPACE_INIT_IMAGE: z.string().default("busybox:1.37"),

    // Tmpfs size cap (megabytes) for the per-run workspace volume.
    // Tmpfs is RAM-backed, fast to allocate/destroy, and self-quoted —
    // ideal for ephemeral per-run scratch space. Set to 0 to fall back
    // to the local volume driver (host disk, no built-in quota).
    WORKSPACE_TMPFS_SIZE_MB: z.coerce.number().int().min(0).max(8192).default(512),

    // Ceiling on the total bytes of input documents a single run may carry
    // into its workspace. Each document is delivered out-of-band (fetched
    // and streamed to disk by the agent), so this is a policy limit, not a
    // memory-safety floor — but it also bounds what the platform buffers
    // while consuming uploads. Default 256 MiB.
    WORKSPACE_MAX_DOCS_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(256 * 1024 * 1024),

    // How long a consumed upload's bytes stay retained — and its upload://
    // URI stays re-consumable — after its FIRST consume. Within this window
    // the same staged upload can feed another run (re-trigger after cancel,
    // `rerun_from`) without a byte-identical re-upload; once the window
    // elapses the GC sweep drops the row and its storage object. Set to 0
    // to restore single-use semantics (consumed uploads become GC-eligible
    // immediately). Storage cost is bounded by the volume of uploads staged
    // within the window.
    UPLOAD_RETENTION_HOURS: z.coerce.number().min(0).max(720).default(24),

    // Per-file ceiling on a durable document (materialized upload or agent
    // output). Enforced synchronously at write time — over-cap writes 413.
    // Default 100 MiB, aligned with the staged-upload absolute ceiling.
    DOCUMENT_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(100 * 1024 * 1024),

    // Per-org durable-storage quota in bytes. Checked synchronously against
    // `organizations.documents_bytes_used` before a document write (403
    // `storage_limit_exceeded` on over-cap). Absent ⇒ unlimited (OSS default);
    // Cloud sets a plan value in the same column.
    ORG_STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().optional(),

    // Ceiling on the total bytes of documents a single run may publish as
    // output (Phase 2 ingestion). Default 256 MiB.
    RUN_MAX_OUTPUT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(256 * 1024 * 1024),

    // Default retention for durable documents, in days. Applied as `expires_at`
    // at creation time so the operator sets an instance-wide policy (GitLab
    // pattern). Absent ⇒ permanent (documents never auto-expire) — the OSS
    // default; livrable expiry is the #1 complaint, so this stays opt-in.
    DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),

    // Redis (optional — falls back to in-memory adapters when absent)
    REDIS_URL: z.string().optional(),

    // Outbound proxy
    PROXY_URL: z.string().optional(),

    // Internal-host SSRF allowlist (opt-in). Comma-separated hostnames the
    // operator explicitly trusts on a private address — every platform egress
    // site that consults it (OAuth token exchange/refresh/discovery, LLM
    // upstreams, org proxies, model tests, credential-proxy targets, remote MCP
    // servers, and the sidecar's own gates) skips ONLY the host blocklist for
    // these hosts so self-hosted deployments can reach internal upstreams.
    //
    // Accepts the legacy `OAUTH_ALLOWED_INTERNAL_IDP_HOSTS` name as an alias
    // (the var outgrew its OAuth-only origin): the new name wins when both are
    // set, the old name is honoured only here at the env-parse boundary.
    EGRESS_ALLOW_INTERNAL_HOSTS: z.preprocess(
      (v) => (v === undefined ? process.env.OAUTH_ALLOWED_INTERNAL_IDP_HOSTS || undefined : v),
      z.string().optional(),
    ),

    // Run token signing (required). Dedicated HMAC secret for run bearer
    // tokens — without a key, `Bun.CryptoHasher("sha256", undefined)`
    // degrades to an UNKEYED hash of the runId and anyone who knows a runId
    // (logs, monitoring) can forge its token, so the keyring must never be
    // empty. Same tier as UPLOAD_SIGNING_SECRET.
    //
    // Comma-separated keyring for online rotation (single value = keyring of
    // one): the FIRST key signs new run tokens, ALL keys verify, so rotation
    // does not kill event ingestion for in-flight runs. Rotation pattern:
    // prepend the new key + restart, wait out the longest in-flight run, drop
    // the old key + restart. Each key must be ≥16 chars (and thus comma-free).
    RUN_TOKEN_SECRET: z
      .string()
      .min(1, "RUN_TOKEN_SECRET is required")
      .refine((v) => v.split(",").every((k) => k.length >= 16), {
        message: "RUN_TOKEN_SECRET: each comma-separated key must be at least 16 chars",
      }),

    // Social auth (optional — enables Google/GitHub sign-in when both are set)
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    // Legal URLs (optional — displayed in footer when set)
    LEGAL_TERMS_URL: z.string().optional(),
    LEGAL_PRIVACY_URL: z.string().optional(),

    // AFPS bundle signing
    //
    // AFPS_TRUST_ROOT: JSON array of trusted publishers:
    //   [{ "keyId": "...", "publicKey": "<base64>", "comment": "..." }]
    // Bundles signed by a key not in this list (directly or via chain) are
    // rejected when AFPS_SIGNATURE_POLICY=required.
    AFPS_TRUST_ROOT: jsonEnv<unknown[]>("[]"),
    // AFPS_SIGNATURE_POLICY — how to treat bundle signatures at load:
    //   - "off"      (default) — no verification, unsigned bundles accepted
    //   - "warn"     — verify if signed; log warnings on unsigned/invalid
    //   - "required" — reject unsigned and invalid bundles (load fails)
    AFPS_SIGNATURE_POLICY: z.enum(["off", "warn", "required"]).default("off"),

    // SMTP (optional — enables email verification when all are set)
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),

    // Auth lockdown (self-hosting) — see examples/self-hosting/AUTH_MODES.md.
    //
    // Default behavior is "open mode": anyone who can reach the instance
    // may sign up and create their own organization (good for SaaS / demo).
    // Self-hosters who want "closed mode" (invitation-only) flip these on.
    //
    // AUTH_DISABLE_SIGNUP — when true, blocks brand-new account creation
    // (email/password, magic-link, social OIDC). Three exceptions always pass:
    //   1. Email matches a pending+non-expired invitation in `org_invitations`.
    //   2. Email is in AUTH_PLATFORM_ADMIN_EMAILS.
    //   3. Email matches AUTH_BOOTSTRAP_OWNER_EMAIL (1st run only).
    AUTH_DISABLE_SIGNUP: z
      .string()
      .default("false")
      .refine((v) => v === "true" || v === "false", {
        message: "AUTH_DISABLE_SIGNUP must be 'true' or 'false'",
      })
      .transform((v) => v === "true"),
    // AUTH_DISABLE_ORG_CREATION — when true, only platform admins (see
    // AUTH_PLATFORM_ADMIN_EMAILS) may call POST /api/orgs. Org-less users
    // see a "waiting for invitation" page instead of /onboarding/create.
    AUTH_DISABLE_ORG_CREATION: z
      .string()
      .default("false")
      .refine((v) => v === "true" || v === "false", {
        message: "AUTH_DISABLE_ORG_CREATION must be 'true' or 'false'",
      })
      .transform((v) => v === "true"),
    // AUTH_ALLOWED_SIGNUP_DOMAINS — comma-separated email domain allowlist.
    // When set, signups (outside the 3 exceptions above) are limited to
    // emails whose domain matches one entry. Empty / unset = no domain
    // restriction. Case-insensitive, no leading "@". Example:
    //   AUTH_ALLOWED_SIGNUP_DOMAINS=acme.com,foo.io
    //
    // Validation rejects clearly malformed entries (whitespace inside,
    // missing TLD, invalid chars) at boot — silently treating "acme . com"
    // as "no match" would only surface as "why doesn't signup work" later.
    AUTH_ALLOWED_SIGNUP_DOMAINS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
          .filter(Boolean),
      )
      .refine(
        (arr) =>
          arr.every((d) =>
            /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d),
          ),
        {
          message:
            "AUTH_ALLOWED_SIGNUP_DOMAINS must be a comma-separated list of valid domains (e.g. 'acme.com,foo.io')",
        },
      ),
    // AUTH_PLATFORM_ADMIN_EMAILS — comma-separated email allowlist of
    // platform-level admins. Bypass AUTH_DISABLE_SIGNUP and may call
    // POST /api/orgs even when AUTH_DISABLE_ORG_CREATION=true.
    // Declarative on purpose: no UI, no migration, IaC-friendly. Comparison
    // is case-insensitive against the user's normalized email.
    AUTH_PLATFORM_ADMIN_EMAILS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      )
      .refine((arr) => arr.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)), {
        message: "AUTH_PLATFORM_ADMIN_EMAILS must be a comma-separated list of valid emails",
      }),
    // AUTH_BOOTSTRAP_OWNER_EMAIL — declarative bootstrap path for fresh
    // self-hosted instances in closed mode. When set, this email is allowed
    // to sign up even with AUTH_DISABLE_SIGNUP=true, and an organization is
    // auto-created with this user as owner on first signup. Idempotent: if
    // the user already owns an org, the after-hook is a no-op.
    //
    // Empty is allowed (open mode); anything else must look like an email
    // so a typo (`AUTH_BOOTSTRAP_OWNER_EMAIL=admin`) is caught at boot
    // rather than silently disabling the bootstrap path.
    AUTH_BOOTSTRAP_OWNER_EMAIL: z
      .string()
      .default("")
      .transform((s) => s.trim().toLowerCase())
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
        message: "AUTH_BOOTSTRAP_OWNER_EMAIL must be a valid email or empty",
      }),
    // AUTH_BOOTSTRAP_ORG_NAME — display name of the bootstrap org. Defaults
    // to "Default" when unset. Slug is derived from the name.
    AUTH_BOOTSTRAP_ORG_NAME: z.string().default("Default"),
    // AUTH_BOOTSTRAP_TOKEN — one-shot redemption token for unattended
    // installs that didn't supply a named owner email (#344 Layer 2b).
    // The CLI generates a 256-bit token at install time, writes it into
    // .env, and prints a banner with the redemption URL. The platform
    // reads it at boot, holds it in memory, and lets the first POST to
    // /api/auth/bootstrap/redeem with a matching token claim ownership
    // of the instance — clearing the token in-memory after a single use.
    //
    // Empty (default) = no pending token = normal signup flow. Format
    // matches the CLI's `generateBootstrapToken()` output: base64url,
    // 22-128 chars, alphanumerics + `_-`. The 22-char floor enforces
    // ~128 bits of entropy so a hand-edited `.env` (e.g. `=foo`) cannot
    // bring the brute-force window into reach of the per-IP rate limit;
    // the auth path then validates the exact bytes via timing-safe
    // compare. The CLI's `generateBootstrapToken()` emits 43 chars / 256
    // bits, well above the floor.
    AUTH_BOOTSTRAP_TOKEN: z
      .string()
      .default("")
      .refine((v) => v === "" || /^[A-Za-z0-9_-]{22,128}$/.test(v), {
        message:
          "AUTH_BOOTSTRAP_TOKEN must be empty or a base64url string (22-128 chars, [A-Za-z0-9_-]) — the 22-char floor enforces ~128 bits of entropy",
      }),
  })
  .refine((env) => !env.S3_BUCKET || env.S3_REGION, {
    message: "S3_REGION is required when S3_BUCKET is set",
    path: ["S3_REGION"],
  })
  .refine((env) => env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS < env.REMOTE_RUN_REPLAY_WINDOW_SECONDS, {
    message:
      "WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS must be strictly less than REMOTE_RUN_REPLAY_WINDOW_SECONDS so a replayed event cannot slip past the dedup cache between expiries",
    path: ["WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS"],
  })
  .refine(
    (env) =>
      env.NODE_ENV !== "production" ||
      env.APP_URL.startsWith("https://") ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(env.APP_URL),
    {
      message: "APP_URL must use https:// when NODE_ENV=production (http://localhost is allowed)",
      path: ["APP_URL"],
    },
  );

// ─── Getter ──────────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

// `createEnvGetter` coalesces `""` → `undefined` across the entire
// process.env snapshot before validating, so `.default(...)` fires
// uniformly for compose's `${VAR:-}` pattern. No per-field opt-in
// needed; see `@appstrate/core/env::sanitizeEnv` for the rationale.
const { getEnv, resetCache } = createEnvGetter(envSchema);

export { getEnv };
export const _resetCacheForTesting = resetCache;
