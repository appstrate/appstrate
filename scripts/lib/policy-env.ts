// SPDX-License-Identifier: Apache-2.0

/**
 * The `warn | fail | off` knob shared by the architecture gates
 * (`verify-module-isolation.ts`, `verify-module-contract.ts`).
 *
 * It exists because the value was previously read with a CAST:
 *
 *   const POLICY = (process.env.X ?? "fail") as "warn" | "fail" | "off";
 *
 * A cast asserts; it does not check. Both gates then exit with
 * `if (problems.length > 0 && POLICY === "fail") process.exit(1)`, so ANY value
 * that is not exactly `fail` — `FAIL`, `faill`, `1`, a trailing space — turned
 * the gate into a printer: it still listed every `❌` and still exited 0. The
 * failure is silent in the worst way, because the operator sees the findings
 * scroll past and the pipeline go green, and nothing in between says the two
 * disagree.
 *
 * Default-secure means rejecting garbage, not falling out of `fail`. An
 * unrecognised value throws here rather than degrading, which is the only
 * reading under which a typo is louder than the thing it was meant to control.
 *
 * The CI pin is applied AFTER validation, deliberately: a malformed value is
 * an operator error worth reporting wherever it is set, and a gate that
 * silently discards its input under CI teaches people the variable works when
 * it does not.
 */

const POLICIES = ["warn", "fail", "off"] as const;

type GatePolicy = (typeof POLICIES)[number];

function isGatePolicy(value: string): value is GatePolicy {
  return (POLICIES as readonly string[]).includes(value);
}

/**
 * Read `name` from the environment as a gate policy.
 *
 * - unset            → `"fail"` (default-secure)
 * - `warn|fail|off`  → itself
 * - anything else    → throws
 *
 * Under CI the result is pinned to `"fail"` regardless, so a green pipeline
 * cannot be bought by exporting `off`. That pin is REACHABLE through turbo, and
 * this is not an assumption: `turbo.json` sets no `envMode` (strict) and does
 * not list `CI` in `globalPassThroughEnv`, but turbo forwards its built-in
 * system/CI variables on top of that list. Probed 2026-08-25 by printing
 * `process.env` from inside this gate's turbo task —
 * `CI=true APPSTRATE_PROBE_UNLISTED=yes GITHUB_ACTIONS=true turbo run
 * '//#verify:module-isolation' --force` → `CI="true" GITHUB_ACTIONS="true"
 * RANDOM=undefined`. The unlisted variable was dropped; `CI` was not. Do not
 * add `CI` to `globalPassThroughEnv` on the theory that it is missing — it is
 * already there by turbo's own default, and re-listing it would suggest the
 * opposite.
 */
export function readGatePolicy(name: string): GatePolicy {
  const raw = process.env[name];

  if (raw !== undefined && !isGatePolicy(raw)) {
    throw new TypeError(
      `${name}=${JSON.stringify(raw)} is not a policy. ` +
        `Expected one of: ${POLICIES.join(", ")}. ` +
        `Refusing to run: an unrecognised value used to degrade this gate to "print the ` +
        `findings and exit 0", which is indistinguishable from a pass.`,
    );
  }

  // Ignored under CI on purpose — see the doc comment above for the probe that
  // shows turbo really does forward `CI` into this task.
  if (process.env["CI"]) return "fail";

  return raw ?? "fail";
}
