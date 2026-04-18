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
import { randomBytes } from "node:crypto";

const SERVICE = "appstrate-ci-probe";
// Nonce included so two reruns on the same CI runner within the same
// second don't collide on a lingering entry if a prior probe somehow
// wrote and failed to clean up. PID alone is not enough (same PID on a
// recycled runner), nor is `Date.now()` (two probes in the same tick).
const ACCOUNT = `probe-${process.pid}-${randomBytes(8).toString("hex")}`;

const NO_BACKEND_MARKERS = [
  "Platform secure storage failure",
  "No secret service available",
  "SecretService",
  "DBus",
  "org.freedesktop.secrets",
];

/**
 * Distinct from `NO_BACKEND_MARKERS`: these strings are what napi-rs
 * returns when the backend IS working but the probed entry simply
 * doesn't exist yet. Used on the "entry-missing" confirmation probe
 * below — if we see this wording, the backend is fully functional,
 * which is strictly stronger evidence than "no backend" alone.
 */
const ENTRY_MISSING_MARKERS = ["No matching entry"];

function isNoBackendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return NO_BACKEND_MARKERS.some((marker) => message.includes(marker));
}

function isEntryMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return ENTRY_MISSING_MARKERS.some((marker) => message.includes(marker));
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
      // Confirmation probe — a *second* operation on an entry we haven't
      // written must also fail with a backend-missing or entry-missing
      // error. Without this, a future regression where the native binding
      // loads but every single operation throws a generic "SecretService"
      // error (broad substring match in `isNoBackendError`) would pass
      // silently — the probe's whole point is to catch such stubs. A
      // freshly-constructed `Entry` that has never been written to MUST
      // yield either `entry-missing` (backend working, nothing stored
      // yet) or `no-backend`; anything else means the binding is in a
      // degraded state we can't distinguish from a load failure.
      try {
        const freshEntry = new Entry(
          SERVICE,
          `nonexistent-${process.pid}-${randomBytes(8).toString("hex")}`,
        );
        freshEntry.getPassword();
        // If this call returned *without* throwing, something is very
        // wrong — we never wrote that entry. Fall through to FAIL.
        process.stderr.write(
          "FAIL: confirmation probe returned a value for an entry we never wrote.\n",
        );
        process.exit(2);
      } catch (confirmErr) {
        if (isNoBackendError(confirmErr) || isEntryMissingError(confirmErr)) {
          process.stdout.write(
            `OK (no backend): native binding loaded, backend unavailable on this runner — ${opErr instanceof Error ? opErr.message : String(opErr)}\n`,
          );
          process.exit(0);
        }
        process.stderr.write(
          `FAIL: confirmation probe threw an unexpected error (native binding likely stubbed): ${confirmErr instanceof Error ? confirmErr.message : String(confirmErr)}\n`,
        );
        if (confirmErr instanceof Error && confirmErr.stack) {
          process.stderr.write(confirmErr.stack + "\n");
        }
        process.exit(2);
      }
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
