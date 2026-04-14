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
    // Dedicated HMAC secret for FS upload-sink tokens. When absent, falls back
    // to BETTER_AUTH_SECRET — set this explicitly so rotating auth secrets
    // does not invalidate in-flight uploads (and vice versa).
    UPLOAD_SIGNING_SECRET: z.string().min(16).optional(),
    // S3 storage (optional — falls back to filesystem when S3_BUCKET is absent)
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
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
    PLATFORM_API_URL: z.string().optional(),
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
  .refine((env) => env.NODE_ENV !== "production" || env.APP_URL.startsWith("https://"), {
    message: "APP_URL must use https:// when NODE_ENV=production",
    path: ["APP_URL"],
  });

// ─── Getter ──────────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

const { getEnv, resetCache } = createEnvGetter(envSchema);

export { getEnv };
export const _resetCacheForTesting = resetCache;
