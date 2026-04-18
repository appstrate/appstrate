// SPDX-License-Identifier: Apache-2.0

/**
 * CI-only probe — proves that `@napi-rs/keyring`'s native `.node` binding
 * is actually embedded in the compiled binary and callable at runtime.
 *
 * `bun build --compile` happily produces a binary whose `require("./keyring.<target>.node")`
 * has been replaced by `throw new Error("Cannot require module …")` when the
 * target's platform package isn't present in node_modules — this happens
 * silently on mis-matched cross-compiles. `--help` and `--version` never
 * touch the native module, so the existing smoke tests would pass on a
 * binary that crashes the moment `appstrate login` is invoked.
 *
 * This probe exercises the one operation that forces the native `.node`
 * to load: constructing an `Entry`. Headless CI runners typically don't
 * have a secret-service daemon, so the probe accepts three outcomes:
 *
 *   - `setPassword` / `getPassword` round-trip succeeds → `OK`
 *   - `Entry` construction succeeds but the operation fails with a
 *     backend-missing error → `OK (no backend)`; the CLI falls back
 *     to the 0600 JSON file in this case, which is legitimate
 *   - anything else (module not found, load error) → exit 2
 *
 * Compiled in CI with the same `--target=<matrix.target>` as the main
 * CLI binary and then executed on the matching native runner.
 */

import { Entry } from "@napi-rs/keyring";

const SERVICE = "appstrate-ci-probe";
const ACCOUNT = `probe-${process.pid}`;

const NO_BACKEND_MARKERS = [
  "Platform secure storage failure",
  "No secret service available",
  "SecretService",
  "DBus",
  "org.freedesktop.secrets",
];

function isNoBackendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NO_BACKEND_MARKERS.some((marker) => message.includes(marker));
}

try {
  const entry = new Entry(SERVICE, ACCOUNT);
  try {
    entry.setPassword(`probe-${Date.now()}`);
    const read = entry.getPassword();
    entry.deletePassword();
    if (typeof read !== "string") {
      process.stderr.write(`FAIL: round-trip returned non-string (${typeof read})\n`);
      process.exit(2);
    }
    process.stdout.write(
      "OK: keyring round-trip succeeded (native binding loaded + backend available)\n",
    );
    process.exit(0);
  } catch (opErr) {
    if (isNoBackendError(opErr)) {
      process.stdout.write(
        `OK (no backend): native binding loaded, backend unavailable on this runner — ${opErr instanceof Error ? opErr.message : String(opErr)}\n`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `FAIL: Entry operation failed with unexpected error: ${opErr instanceof Error ? opErr.message : String(opErr)}\n`,
    );
    if (opErr instanceof Error && opErr.stack) process.stderr.write(opErr.stack + "\n");
    process.exit(2);
  }
} catch (loadErr) {
  process.stderr.write(
    `FAIL: could not construct Entry — native binding likely missing from compiled binary. ${loadErr instanceof Error ? loadErr.message : String(loadErr)}\n`,
  );
  if (loadErr instanceof Error && loadErr.stack) process.stderr.write(loadErr.stack + "\n");
  process.exit(2);
}
