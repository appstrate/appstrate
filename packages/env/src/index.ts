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
  })
  .refine((env) => !env.S3_BUCKET || env.S3_REGION, {
    message: "S3_REGION is required when S3_BUCKET is set",
    path: ["S3_REGION"],
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
