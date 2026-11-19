// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth reads its env once, when the singleton is built: a changed var
 * takes effect only after the env cache is reset and the singleton rebuilt.
 * These helpers do both, and put back every var they changed.
 */

import { afterAll, beforeAll } from "bun:test";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";
import { applyEnv, withEnv, type TestEnv } from "./env.ts";

const applyAuthEnv = (vars: TestEnv): void => applyEnv(vars, _rebuildAuthForTesting);

/**
 * For the enclosing suite: applies `initial` before it, when given, and
 * returns a setter for its hooks and tests. After the suite every var either
 * changed is back to its value before the first change, and auth is rebuilt.
 */
export function useAuthEnv(initial?: TestEnv): (vars: TestEnv) => void {
  const original = new Map<string, string | undefined>();
  const set = (vars: TestEnv): void => {
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
export function withAuthEnv<T>(vars: TestEnv, fn: () => Promise<T>): Promise<T> {
  return withEnv(vars, fn, _rebuildAuthForTesting);
}
