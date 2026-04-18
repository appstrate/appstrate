// SPDX-License-Identifier: Apache-2.0

/**
 * CI-only probe — proves that `@napi-rs/keyring`'s native `.node` binding
 * is actually embedded in the compiled binary and loadable at runtime.
 *
 * What we are guarding against
 * ----------------------------
 * `bun build --compile` happily produces a binary whose
 * `require("./keyring.<target>.node")` has been replaced by a throw stub
 * when the target's platform package isn't present in node_modules — this
 * happens silently on mis-matched cross-compiles. `--help` and `--version`
 * never touch the native module, so the existing smoke tests would pass
 * on a binary that crashes the moment `appstrate login` is invoked.
 *
 * What this probe does NOT assert
 * --------------------------------
 * The probe does NOT verify that the platform's secret-store backend is
 * functional or that round-trip storage works. Backend behavior on CI
 * runners is wildly inconsistent across:
 *
 *   - Linux: secret-service / DBus may be absent → `setPassword` throws
 *     a `NO_BACKEND_MARKER` error.
 *   - macOS arm64: native keychain may be locked / unauthenticated →
 *     `setPassword` throws "Platform secure storage failure", and
 *     `getPassword` on a fresh entry returns `null` (NOT a throw).
 *   - macOS x64 (macos-15-intel): keychain may be in a degraded state
 *     where `setPassword` silently succeeds but the very next
 *     `getPassword` returns `null` (so the round-trip "succeeded" but
 *     read back nothing).
 *   - Windows: never observed by us; credential manager presumed
 *     working in headed sessions, undefined in headless.
 *
 * Asserting any specific backend behavior produces a probe that flakes
 * across one runner image bump or another. The ONLY robust invariant is:
 * if the FFI bridge to the native `.node` did not load, we get a
 * recognisable module-load error from Bun. Any other outcome — string
 * back, null back, weird object back, throw with a backend-specific
 * message — proves the binding loaded and surrendered control to the
 * Rust side. That is exactly what we need to know.
 *
 * Compiled in CI with the same `--target=<matrix.target>` as the main
 * CLI binary and then executed on the matching native runner.
 */

import { Entry } from "@napi-rs/keyring";
import { randomBytes } from "node:crypto";

const SERVICE = "appstrate-ci-probe";
// Nonce included so two reruns on the same CI runner within the same
// second don't collide on a lingering entry. PID alone is not enough
// (same PID on a recycled runner), nor is `Date.now()` (two probes in
// the same tick).
const ACCOUNT = `probe-${process.pid}-${randomBytes(8).toString("hex")}`;

/**
 * Bun's `--compile` stub for an absent `.node` binding throws an error
 * whose message includes `Cannot require module` and the `.node` path.
 * Node's native module loader uses `MODULE_NOT_FOUND` / `Cannot find
 * module` for the same scenario. Match conservatively on those signals
 * — a stray `.node` in an unrelated message would over-match, so the
 * pattern requires either an explicit `Cannot require/find module`
 * verb OR a `MODULE_NOT_FOUND` code marker.
 */
const MODULE_LOAD_ERROR = /Cannot (require|find) module|MODULE_NOT_FOUND/i;

function isModuleLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return MODULE_LOAD_ERROR.test(message);
}

function fail(reason: string, err?: unknown): never {
  process.stderr.write(`FAIL: ${reason}\n`);
  if (err instanceof Error) {
    process.stderr.write(`  Error: ${err.message}\n`);
    if (err.stack) process.stderr.write(`  Stack:\n${err.stack}\n`);
  }
  process.exit(2);
}

// Step 1 — instantiate. `new Entry(...)` is the first call that forces
// the .node FFI bridge to load. A module-load failure surfaces here.
let entry: Entry;
try {
  entry = new Entry(SERVICE, ACCOUNT);
} catch (err) {
  if (isModuleLoadError(err)) {
    fail("could not construct Entry — native binding missing from compiled binary.", err);
  }
  // Constructor threw something other than a module-load error → the
  // binding loaded, the Rust side rejected the inputs (extremely
  // unlikely with our hard-coded SERVICE/ACCOUNT, but if it happens
  // the binding is still proven loaded).
  process.stdout.write(
    `OK: native binding loaded (constructor surrendered to Rust with non-load error: ${err instanceof Error ? err.message : String(err)})\n`,
  );
  process.exit(0);
}

// Step 2 — invoke a method. We pick `getPassword()` because it has no
// side-effects on the underlying store. We do NOT care whether it
// returns a string, returns null, or throws — only whether the throw
// (if any) is a module-load failure.
try {
  const result = entry.getPassword();
  process.stdout.write(
    `OK: native binding loaded (getPassword returned ${result === null ? "null" : typeof result === "string" ? `string(${result.length})` : typeof result})\n`,
  );
  process.exit(0);
} catch (err) {
  if (isModuleLoadError(err)) {
    fail("getPassword threw module-load error — native binding stubbed.", err);
  }
  process.stdout.write(
    `OK: native binding loaded (getPassword threw non-load error: ${err instanceof Error ? err.message : String(err)})\n`,
  );
  process.exit(0);
}
