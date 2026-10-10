// SPDX-License-Identifier: Apache-2.0

import { envSchema, findUnreadEnvKeys } from "@appstrate/env";
import { SIDECAR_OPERATOR_ENV_KEYS } from "@appstrate/runner-pi";
import { logger } from "./logger.ts";

export type UnreadKeyWarn = (msg: string, fields: Record<string, unknown>) => void;

/**
 * Every environment key the platform itself consumes: the schema keys and the
 * operator keys forwarded into sidecar containers. Infra keys are known to
 * `findUnreadEnvKeys` without defining a namespace.
 */
function platformReadEnvKeys(): ReadonlySet<string> {
  return new Set([...Object.keys(envSchema.shape), ...SIDECAR_OPERATOR_ENV_KEYS]);
}

/**
 * Logs one warning naming the set keys that fall in a platform namespace but
 * are not read, so a renamed, retired or misspelled setting is visible at boot.
 * An empty value counts as unset, matching how the env getter reads it.
 */
export function warnOnUnreadEnvKeys(
  env: Record<string, string | undefined> = process.env,
  warn: UnreadKeyWarn = (msg, fields) => logger.warn(msg, fields),
): string[] {
  const present = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key]) => key);
  const keys = findUnreadEnvKeys(present, platformReadEnvKeys());
  if (keys.length > 0) {
    warn(
      "Environment keys this version does not read — a renamed, retired or misspelled setting has no effect",
      { keys, docs: "docs/ENV.md#unread-keys" },
    );
  }
  return keys;
}
