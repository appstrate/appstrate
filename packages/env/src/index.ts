// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { createEnvGetter } from "@appstrate/core/env";

// ─── Schema ──────────────────────────────────────────────────

const envSchema = z
  .object({
    // Node environment — gates production-only invariants (e.g. APP_URL https)
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
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
        try {
          return JSON.parse(s) as unknown;
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
    UPLOAD_SIGNING_SECRET: z.string().min(16, "UPLOAD_SIGNING_SECRET must be at least 16 chars"),
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
    SYSTEM_PROXIES: z
      .string()
      .default("[]")
      .transform((s) => JSON.parse(s) as unknown[]),
    SYSTEM_PROVIDER_KEYS: z
      .string()
      .default("[]")
      .transform((s) => JSON.parse(s) as unknown[]),

    // OIDC instance clients — declarative provisioning of satellite OAuth
    // clients (admin dashboards, second-party web apps). Parsed loosely
    // here; the oidc module applies a strict Zod schema at boot. See
    // `apps/api/src/modules/oidc/services/instance-client-sync.ts`.
    OIDC_INSTANCE_CLIENTS: z
      .string()
      .default("[]")
      .transform((s) => JSON.parse(s) as unknown[]),

    // Platform-wide run limits (applied to EVERY run — classic + inline).
    // Empty object means defaults apply. Validated strictly inside the API
    // layer (apps/api/src/services/run-limits.ts); defaults are designed to
    // be non-breaking for existing deployments.
    PLATFORM_RUN_LIMITS: z
      .string()
      .default("{}")
      .transform((s) => JSON.parse(s) as Record<string, unknown>),

    // Inline-run specific limits (caps on manifest size, skills/tools count,
    // authorized URIs, retention). See docs/specs/INLINE_RUNS.md §6.
    INLINE_RUN_LIMITS: z
      .string()
      .default("{}")
      .transform((s) => JSON.parse(s) as Record<string, unknown>),

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
    REMOTE_RUN_EVENT_LIMITS: z
      .string()
      .default("{}")
      .transform((s) => JSON.parse(s) as Record<string, unknown>),
    // Redis dedup window for webhook-id replay detection. MUST exceed the
    // Standard Webhooks timestamp tolerance (5 min) so a replayed event
    // cannot slip through after its cache entry expires.
    REMOTE_RUN_REPLAY_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
    // Out-of-order event buffer flush window. Events with non-contiguous
    // sequence numbers wait up to this long for the gap to fill; terminal
    // events (run.completed/failed/timeout/cancelled) flush immediately
    // regardless of gaps.
    REMOTE_RUN_BUFFER_FLUSH_MS: z.coerce.number().int().positive().default(5000),

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

    // Modules (comma-separated specifiers).
    // Default loads built-in OSS modules (oidc, webhooks).
    // Append external specifiers (npm package names) to extend.
    MODULES: z.string().default("oidc,webhooks"),

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

    // Run — execution backend: "docker" (isolated containers) or "process" (default, Bun subprocesses, no isolation)
    RUN_ADAPTER: z.enum(["docker", "process"]).default("process"),
    SIDECAR_POOL_SIZE: z.coerce.number().int().min(0).default(2),

    // Docker images (override for GHCR / custom registries)
    PI_IMAGE: z.string().default("appstrate-pi:latest"),
    SIDECAR_IMAGE: z.string().default("appstrate-sidecar:latest"),

    // Redis (optional — falls back to in-memory adapters when absent)
    REDIS_URL: z.string().optional(),

    // Outbound proxy
    PROXY_URL: z.string().optional(),

    // Run token signing (optional — if unset, run tokens are unsigned)
    RUN_TOKEN_SECRET: z.string().optional(),

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
    AFPS_TRUST_ROOT: z
      .string()
      .default("[]")
      .transform((s) => JSON.parse(s) as unknown[]),
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

const { getEnv, resetCache } = createEnvGetter(envSchema);

export { getEnv };
export const _resetCacheForTesting = resetCache;
