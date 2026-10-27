// SPDX-License-Identifier: Apache-2.0

import { envSchema } from "@appstrate/env";
import { SIDECAR_OPERATOR_ENV_KEYS } from "@appstrate/runner-pi";

/**
 * Keys platform code reads straight from `process.env`, outside the schema.
 * `AUTH_FAST_TEST_HASH` is set by `test/setup/preload.ts` and read by
 * `packages/db/src/auth.ts` to swap in a fast password hasher outside production.
 */
const DIRECT_READ_ENV_KEYS = ["AUTH_FAST_TEST_HASH"] as const;

/**
 * Every environment key the platform itself consumes: the schema keys, the
 * operator keys forwarded into sidecar containers, and the direct reads above.
 * Infra keys are known to `findUnreadEnvKeys` without defining a namespace.
 * Logger-free, so a test can import it without validating the env.
 */
export function platformReadEnvKeys(): ReadonlySet<string> {
  return new Set([
    ...Object.keys(envSchema.shape),
    ...SIDECAR_OPERATOR_ENV_KEYS,
    ...DIRECT_READ_ENV_KEYS,
  ]);
}
