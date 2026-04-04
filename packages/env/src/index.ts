// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { createEnvGetter } from "@appstrate/core/env";

// ─── Schema ──────────────────────────────────────────────────

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
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

  // Run — execution backend: "docker" (default, isolated containers) or "process" (Bun subprocesses, no isolation)
  RUN_ADAPTER: z.enum(["docker", "process"]).default("docker"),
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

  // SMTP (optional — enables email verification when all are set)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

// ─── Getter ──────────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

const { getEnv, resetCache } = createEnvGetter(envSchema);

export { getEnv };
export const _resetCacheForTesting = resetCache;
