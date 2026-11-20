// SPDX-License-Identifier: Apache-2.0

/** Process env changes for a test, the cached env read again and every var put back after. */

import { _resetCacheForTesting } from "@appstrate/env";

/** `undefined` unsets the var. */
export type TestEnv = Readonly<Record<string, string | undefined>>;

/** Sets `vars`, resets the env cache, then runs `reload` for a registry read once from it. */
export function applyEnv(vars: TestEnv, reload?: () => void): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetCacheForTesting();
  reload?.();
}

/** Runs `fn` under `vars`, then puts the previous values back; `reload` follows each change. */
export async function withEnv<T>(
  vars: TestEnv,
  fn: () => Promise<T>,
  reload?: () => void,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  try {
    applyEnv(vars, reload);
    return await fn();
  } finally {
    applyEnv(previous, reload);
  }
}
