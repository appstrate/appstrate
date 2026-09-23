// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * This module's environment contract, parsed once. Exported for the platform's
 * env gates (`scripts/verify-env-docs.ts`, `scripts/verify-compose-defaults.ts`),
 * which glob `packages/module-<id>/src/env.ts`.
 *
 * Parsed at module `init()`, so a bad value fails boot.
 *
 * `CHAT_SELF_ORIGIN` must stay on-host: `forwardedHeaders` sends the caller's
 * cookie / Authorization on that hop, so an external origin would exfiltrate
 * them. Empty reads as unset (compose `${VAR:-}`).
 */
const emptyAsUnset = (v: unknown) => (v === "" ? undefined : v);

export const chatEnvSchema = z.object({
  /**
   * Cap on concurrent in-process chat turns per API process (each holds a Pi
   * session). Unset means the built-in default, which boot warns about.
   */
  CHAT_PI_MAX_CONCURRENCY: z.preprocess(
    emptyAsUnset,
    z.coerce.number().int().positive().optional(),
  ),
  CHAT_SELF_ORIGIN: z.preprocess(
    emptyAsUnset,
    z
      .url()
      .refine((url) => LOOPBACK_HOSTS.has(URL.parse(url)?.hostname ?? ""), {
        message:
          "must be a loopback origin — the chat module forwards the caller's cookie/Authorization on this hop and must never send them off-host",
      })
      .optional(),
  ),
});

interface ChatEnv {
  /**
   * Loopback origin of the running platform (same process, no proxy hop):
   * `CHAT_SELF_ORIGIN`, else the platform's own `PORT` — validated by
   * `@appstrate/env`, which this module does not import.
   */
  selfOrigin: string;
  /** Operator-set `CHAT_PI_MAX_CONCURRENCY`; absent means the built-in default. */
  piMaxConcurrency?: number;
}

let cached: ChatEnv | null = null;

export function getChatEnv(): ChatEnv {
  if (!cached) {
    const env = chatEnvSchema.parse(process.env);
    cached = {
      selfOrigin: env.CHAT_SELF_ORIGIN ?? `http://127.0.0.1:${process.env.PORT || "3000"}`,
      ...(env.CHAT_PI_MAX_CONCURRENCY !== undefined
        ? { piMaxConcurrency: env.CHAT_PI_MAX_CONCURRENCY }
        : {}),
    };
  }
  return cached;
}

/** Test-only — drop the cached parse so the next read sees `process.env` again. */
export function _resetChatEnvForTests(): void {
  cached = null;
}
