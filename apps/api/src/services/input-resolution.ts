// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's binding of `@appstrate/core/input-resolution`.
 *
 * The resolution itself — the layer order, the shallow per-property overlay,
 * the refusal of a locked field — lives in core, shared verbatim with the CLI
 * (`appstrate run --local`) so the same agent launched the same way yields the
 * same parameters wherever it runs. What lives HERE is the part that is the
 * API's alone: the HTTP error a refusal produces, and the write-time guard on
 * the lock configuration itself, which has no local-run counterpart.
 *
 * The API's layers, last one wins:
 *
 *   author default   (manifest `input.schema` JSON Schema `default` keyword)
 *     -> editor default   (`space_packages.input_settings.values`)
 *       -> the overlay   <- REFUSED on a locked field
 *
 * The top layer is the single `overlay`, and which source fills it is what
 * each call site declares: a manual launch and the inline preflight pass the
 * run-time caller's input (`origin: "input"`), the schedule paths pass the
 * schedule's frozen values (`origin: "schedule input"`) because a cron fire
 * has no caller. No path has both.
 */

import { ApiError } from "../lib/errors.ts";
import { asJSONSchemaObject, authorDefaults, type JSONSchemaObject } from "@appstrate/core/form";
import { validateInput } from "./schema.ts";
import {
  resolveEffectiveInput as resolveEffectiveInputCore,
  type InputLayers,
  type InputOverlayOrigin,
} from "@appstrate/core/input-resolution";

/**
 * The refusal the API owes a caller that set a locked field: a 400 naming the
 * offending field and the layer it must be removed from.
 */
function lockedFieldError(field: string, origin: InputOverlayOrigin): ApiError {
  return new ApiError({
    status: 400,
    code: "locked_input_field",
    title: "Locked Input Field",
    detail: `Field '${field}' is locked on this agent and cannot be set at launch — remove it from the ${origin}.`,
    param: `input.${field}`,
  });
}

/**
 * Collapse the layers into the input a run executes with.
 *
 * Throws `ApiError(400, "locked_input_field")` when the overlay — the caller's
 * input, or a schedule's frozen values — names a locked field.
 */
export function resolveEffectiveInput(
  layers: Omit<InputLayers, "lockedFieldError">,
): Record<string, unknown> {
  return resolveEffectiveInputCore({ ...layers, lockedFieldError });
}

/**
 * Write-time guard: a required field may not be locked with no value behind it.
 *
 * Locking a field removes it from the launch form, so a required field locked
 * with neither an author `default` nor an editor value is unsatisfiable AND
 * invisible — every run of the agent would fail schema validation and no user
 * could see why. Refuse the configuration instead of shipping the dead end.
 *
 * Throws `ApiError(400, "locked_required_field_empty")`.
 */
export function assertLockedFieldsSatisfiable(
  schema: JSONSchemaObject | undefined,
  lockedFields: readonly string[],
  editorValues: Record<string, unknown>,
): void {
  if (lockedFields.length === 0) return;
  const required = new Set(schema?.required ?? []);
  const defaults = authorDefaults(schema);
  for (const field of lockedFields) {
    if (!required.has(field)) continue;
    if (editorValues[field] !== undefined) continue;
    if (defaults[field] !== undefined) continue;
    throw new ApiError({
      status: 400,
      code: "locked_required_field_empty",
      title: "Locked Required Field Has No Value",
      detail: `Field '${field}' is required and cannot be locked without a value — set a value for it, or unlock it so it is asked at launch.`,
      param: `locked_fields.${field}`,
    });
  }
}

/**
 * Resolve a schedule's stored input through the layers and validate the result
 * against the agent's schema, WITHOUT choosing a failure channel.
 *
 * Three call sites need exactly this pair, and they answer differently: the
 * create route throws `validationFailed`, the update route does too, and the
 * fire path calls `failSchedule` and logs. Writing the pair out per site is
 * what let them drift — `PUT /api/schedules/:id` had adopted only the
 * lock half (core's `assertFieldsUnlocked`) and skipped the validation
 * entirely, so a PUT that replaced `input` with a wrong-typed or incomplete
 * value answered 200 and then failed at EVERY subsequent tick. The create
 * route's own comment says the point is to refuse "at this write rather than
 * silently each tick"; its sibling did the opposite.
 *
 * A `null` schema means the agent declares none, in which case there is
 * nothing to validate and the resolved input is returned as-is. Resolution
 * itself can still throw `ApiError(400, "locked_input_field")` — that refusal
 * has one shape everywhere and is deliberately left to propagate.
 */
export function resolveAndValidateScheduleInput(args: {
  inputSchema: unknown;
  editorDefaults: Record<string, unknown> | undefined;
  lockedFields: readonly string[] | undefined;
  input: Record<string, unknown> | undefined;
}):
  | { resolved: Record<string, unknown>; errors?: undefined }
  | { errors: { field: string; message: string }[] } {
  const schema = args.inputSchema ? asJSONSchemaObject(args.inputSchema) : undefined;
  const resolved = resolveEffectiveInput({
    ...(schema ? { schema } : {}),
    editorDefaults: args.editorDefaults,
    lockedFields: args.lockedFields,
    overlay: { origin: "schedule input", values: args.input },
  });
  if (!schema) return { resolved };

  const validation = validateInput(resolved, schema);
  if (!validation.valid) return { errors: validation.errors };
  return { resolved };
}
