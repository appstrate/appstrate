// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth reads its env once, when the singleton is built: a changed var
 * takes effect only after the env cache is reset and the singleton rebuilt.
 * These helpers do both, and put back every var they changed.
 */

import { afterAll, beforeAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";

/** `undefined` unsets the var. */
type AuthEnv = Readonly<Record<string, string | undefined>>;

function applyAuthEnv(vars: AuthEnv): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetCacheForTesting();
  _rebuildAuthForTesting();
}

/**
 * For the enclosing suite: applies `initial` before it, when given, and
 * returns a setter for its hooks and tests. After the suite every var either
 * changed is back to its value before the first change, and auth is rebuilt.
 */
export function useAuthEnv(initial?: AuthEnv): (vars: AuthEnv) => void {
  const original = new Map<string, string | undefined>();
  const set = (vars: AuthEnv): void => {
    for (const key of Object.keys(vars)) {
      if (!original.has(key)) original.set(key, process.env[key]);
    }
    applyAuthEnv(vars);
  };
  if (initial) beforeAll(() => set(initial));
  afterAll(() => {
    applyAuthEnv(Object.fromEntries(original));
    original.clear();
  });
  return set;
}

/** Runs `fn` under `vars`, then puts the previous values back and rebuilds auth. */
export async function withAuthEnv<T>(vars: AuthEnv, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  try {
    applyAuthEnv(vars);
    return await fn();
  } finally {
    applyAuthEnv(previous);
  }
}
