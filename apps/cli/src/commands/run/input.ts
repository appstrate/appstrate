// SPDX-License-Identifier: Apache-2.0

/**
 * Input resolution + validation for a LOCAL `appstrate run`.
 *
 * The platform resolves an agent's declared defaults and the per-space
 * stored values on every launch, then validates the result against the
 * manifest's `input.schema`. A local run reaches none of those code paths, so
 * this module runs the same two steps with the same shared implementations
 * (`@appstrate/core/input-resolution`, `@appstrate/core/schema-validation`) —
 * otherwise `appstrate run @scope/agent` executes the same agent with
 * different parameters than the dashboard would.
 *
 * Kept out of `commands/run.ts`: these are pure functions over a manifest, and
 * living in the 1300-line command file forced their test to import PiRunner,
 * the sink stack and the shutdown coordinator to exercise a few lines of
 * object spread.
 */

import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { resolveEffectiveInput } from "@appstrate/core/input-resolution";
import { validateAgainstSchema } from "@appstrate/core/schema-validation";
import { exitWithError } from "../../lib/ui.ts";
import type { CommandIO } from "../../lib/io.ts";

/**
 * The per-space input layer a REMOTE package carries with it — what
 * `space_packages.input_settings` stores, as delivered by the
 * `run-config` endpoint. Absent for a bundle read off disk: that target has
 * no space row behind it, so there is nothing to inherit.
 */
export interface StoredInputLayer {
  /** Editor-set values — layer 2 of the platform's input resolution. */
  values: Record<string, unknown>;
  /** Input fields the editor froze. */
  lockedFields: readonly string[];
}

/**
 * Raised when the caller's `--input` / `--input-file` names a field the
 * editor locked — the CLI's own shape of the refusal the shared resolver
 * asks its host for, where the server builds its `400 locked_input_field`
 * problem document instead. The wording is the server's, verbatim.
 */
export class LockedInputFieldError extends Error {
  constructor(public readonly field: string) {
    super(
      `Field '${field}' is locked on this agent and cannot be set at launch — remove it from the input.`,
    );
    this.name = "LockedInputFieldError";
  }
}

/**
 * Layer the agent's stored input underneath a local run's caller input.
 *
 * Reads the bundle's `input.schema` off disk and hands it, the stored editor
 * layer and the caller's values to the platform's own resolver
 * (`@appstrate/core/input-resolution`) — the same code, in the same order,
 * that `apps/api` runs on a hosted launch. The overlay above the editor layer
 * is always the caller here: a local run has no schedules, so the platform's
 * other overlay origin (a scheduled trigger's frozen values) has no local
 * counterpart.
 *
 * A property with no value at any layer stays absent rather than being
 * materialised as `null`. Nothing downstream enforces `required` on its own —
 * the runtime reads `input.schema.required` only to print the word "required"
 * next to the field in the platform prompt (`renderPlatformPrompt`) — so
 * resolution alone would let a missing required field reach the model as an
 * empty render. `validateLocalInput` below is the gate; call it on the result.
 *
 * A caller value naming a locked field is REFUSED, not dropped: silently
 * ignoring it would run the agent with parameters other than the ones
 * asked for. Be honest about what that buys — a developer running the CLI
 * already holds the bundle and executes it in their own shell, so nothing
 * here stops them from editing the manifest or the input afterwards. This
 * is NOT a security boundary against the caller. It is parity: the same
 * agent launched the same way yields the same parameters whether it runs
 * on the platform or locally, and a lock the editor set is never silently
 * ignored.
 */
export function resolveLocalInput(
  bundle: Bundle,
  callerInput: Record<string, unknown>,
  stored?: StoredInputLayer | undefined,
): Record<string, unknown> {
  const schema = readBundleInputSchema(bundle);
  return resolveEffectiveInput({
    ...(schema ? { schema } : {}),
    editorDefaults: stored?.values,
    lockedFields: stored?.lockedFields,
    overlay: { origin: "input", values: callerInput },
    lockedFieldError: (field) => new LockedInputFieldError(field),
  });
}

/**
 * Gate a resolved input against the bundle's declared `input.schema`,
 * BEFORE launching PiRunner.
 *
 * The platform runs this same gate on every launch path — `parseRunInput`
 * (`apps/api/src/services/input-parser.ts`), the scheduler and the inline-run
 * preflight all follow `resolveEffectiveInput` with `validateInput`. A local
 * run reaches none of them, so without this call `appstrate run --local`
 * succeeds on an input the dashboard would have rejected: a required field
 * answered nowhere, a string where the schema declares a number, a value
 * outside a declared `enum`. The model then receives the field rendered as
 * an empty string with no error anywhere.
 *
 * Both sides go through `validateAgainstSchema` (`@appstrate/core/schema-validation`,
 * which the server's `validateInput` wraps), so the same `(input, schema)`
 * pair reaches the same verdict locally and on the platform.
 *
 * An agent that declares no `input.schema` accepts anything — nothing to
 * validate against, so the gate is a no-op rather than a rejection.
 *
 * `io` exists for the tests: on failure this exits the process, and a test
 * asserting that needs its own sink rather than the real streams.
 */
export function validateLocalInput(
  bundle: Bundle,
  input: Record<string, unknown>,
  io?: CommandIO,
): void {
  const schema = readBundleInputSchema(bundle);
  if (!schema) return;
  const result = validateAgainstSchema(input, schema);
  if (result.valid) return;
  const summary = result.errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n");
  exitWithError(
    `Resolved input does not match the agent's manifest input schema:\n${summary}\n\n` +
      `The value checked is the resolved one — author defaults, then the\n` +
      `stored per-space values, then your --input / --input-file.\n` +
      `Fix the stored input in the dashboard, or pass a corrected\n` +
      `--input <json> / --input-file <path> override.`,
    io,
  );
}

/**
 * Pull the AFPS `input.schema` JSON Schema out of the bundle's root
 * package manifest. Returns `undefined` when the agent declares no input
 * schema (so default resolution is a no-op).
 */
function readBundleInputSchema(bundle: Bundle): JSONSchemaObject | undefined {
  const rootPkg = bundle.packages.get(bundle.root);
  const manifest = rootPkg?.manifest as Record<string, unknown> | undefined;
  const section = manifest?.input;
  if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
  const schema = (section as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return schema as JSONSchemaObject;
}
