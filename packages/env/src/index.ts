import { z } from "zod";
import { createEnvGetter } from "@appstrate/core/env";

// ─── Schema ──────────────────────────────────────────────────

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
  STORAGE_DIR: z.string().default(""),

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
  SYSTEM_MODELS: z
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
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  PLATFORM_API_URL: z.string().optional(),
  OAUTH_CALLBACK_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Execution
  EXECUTION_ADAPTER: z.enum(["pi"]).default("pi"),

  // Registry
  REGISTRY_URL: z.string().optional(),
  REGISTRY_CLIENT_ID: z.string().optional(),
  REGISTRY_CLIENT_SECRET: z.string().optional(),

  // Outbound proxy
  PROXY_URL: z.string().optional(),

  // Execution token signing (falls back to BETTER_AUTH_SECRET if unset)
  EXECUTION_TOKEN_SECRET: z.string().optional(),
});

// ─── Getter ──────────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

const { getEnv, resetCache } = createEnvGetter(envSchema);

export { getEnv };
export const _resetCacheForTesting = resetCache;

