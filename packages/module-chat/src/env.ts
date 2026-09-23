// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** This module's env contract, parsed at `init()`; empty reads as unset. */
const emptyAsUnset = (v: unknown) => (v === "" ? undefined : v);

export const chatEnvSchema = z.object({
  /** Concurrent in-process chat turns per API process; unset = default (boot warns). */
  CHAT_PI_MAX_CONCURRENCY: z.preprocess(
    emptyAsUnset,
    z.coerce.number().int().positive().optional(),
  ),
  /** Must stay on-host: the caller's cookie/Authorization is forwarded on that hop. */
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
  /** Loopback origin of the running platform: `CHAT_SELF_ORIGIN`, else `PORT`. */
  selfOrigin: string;
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

export function _resetChatEnvForTests(): void {
  cached = null;
}
