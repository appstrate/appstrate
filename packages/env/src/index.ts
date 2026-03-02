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
  SYSTEM_PROVIDERS: z
    .string()
    .default("[]")
    .transform((s) => JSON.parse(s) as unknown[]),
  SYSTEM_PROXIES: z
    .string()
    .default("[]")
    .transform((s) => JSON.parse(s) as unknown[]),

  // App
  APP_URL: z.string().default("http://localhost:3010"),
  TRUSTED_ORIGINS: z
    .string()
    .default("http://localhost:3010,http://localhost:5173")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  PORT: z.coerce.number().int().positive().default(3010),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  DATA_DIR: z.string().optional(),
  PLATFORM_API_URL: z.string().optional(),
  OAUTH_CALLBACK_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Execution
  EXECUTION_ADAPTER: z.enum(["pi"]).default("pi"),
  LLM_PROVIDER: z.string().default("anthropic"),
  LLM_MODEL_ID: z.string().default("claude-sonnet-4-5-20250929"),

  // LLM API keys (passthrough to containers)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  TOGETHER_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),

  // Registry
  REGISTRY_URL: z.string().optional(),

  // Outbound proxy
  PROXY_URL: z.string().optional(),
});

// ─── Getter ──────────────────────────────────────────────────

export type Env = z.infer<typeof envSchema>;

const { getEnv, resetCache } = createEnvGetter(envSchema);

export { getEnv };
export const _resetCacheForTesting = resetCache;

// ─── Constants ───────────────────────────────────────────────

/** LLM API key env var names for passthrough to containers. */
export const LLM_API_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "DEEPSEEK_API_KEY",
] as const satisfies readonly (keyof Env)[];
