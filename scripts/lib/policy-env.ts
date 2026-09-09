// SPDX-License-Identifier: Apache-2.0

/**
 * The `warn | fail | off` knob shared by the architecture gates
 * (`verify-module-isolation.ts`, `verify-module-contract.ts`), CHECKED here
 * rather than cast at the call site. Both exit on `problems.length > 0 && POLICY
 * === "fail"`, so any value that is not exactly `fail` — `FAIL`, `faill`, `1`, a
 * trailing space — makes the gate a printer: every `❌` listed, exit 0, findings
 * scrolling past a green pipeline with nothing saying the two disagree. An
 * unrecognised value THROWS instead of degrading into `fail`; default-secure
 * means rejecting garbage, the only reading under which a typo is louder than
 * the thing it controls. The CI pin applies AFTER validation: a malformed value
 * is an operator error worth reporting wherever it is set, and a gate that
 * silently discards its input teaches people it works.
 */

const POLICIES = ["warn", "fail", "off"] as const;

/**
 * Is this process running under CI?
 *
 * `if (process.env["CI"])` was JS truthiness on a string, so `CI=false` — which
 * some runners export precisely to say "not CI", and which a developer can
 * export locally for the same reason — read as CI and pinned the policy to
 * `fail`. Every other boolean env var in this repo goes through `boolEnv` in
 * `packages/env/src/index.ts`, whose rule is `s.toLowerCase() === "true" || s
 * === "1"`; that rule is restated here rather than imported because `env` does
 * not export the helper, and because a gate script must not need the platform's
 * env schema to boot. If `boolEnv` ever changes, change this with it.
 *
 * Unset stays false, which is the same answer truthiness gave.
 */
function isCi(): boolean {
  const raw = process.env["CI"];
  return raw !== undefined && (raw.toLowerCase() === "true" || raw === "1");
}

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
  // shows turbo really does forward `CI` into this task, and `isCi` for why
  // this is not a truthiness check on the raw string.
  if (isCi()) return "fail";

  return raw ?? "fail";
}
