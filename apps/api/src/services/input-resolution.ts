// SPDX-License-Identifier: Apache-2.0

/**
 * Unified input resolution — the single place the platform decides what an
 * agent run actually receives in `input`.
 *
 * An AFPS manifest declares ONE parameter schema (`input`). Whether a value is
 * asked at every launch or set once and reused is a platform concern, not a
 * manifest concern: it is expressed as stored values plus per-field locks on
 * `application_packages`.
 *
 * Four layers, last one wins:
 *
 *   author default   (manifest `input.schema` JSON Schema `default` keyword)
 *     -> editor default   (`application_packages.input_settings.values`)
 *       -> schedule values   (`package_schedules.input`)
 *         -> run-time caller input   <- REFUSED on a locked field
 *
 * The merge is a shallow per-property overlay: a layer either supplies a
 * top-level property or it does not. There is no deep merge — a property's
 * value is owned by exactly one layer, which is what makes "which layer did
 * this come from" answerable at every call site.
 */

import { ApiError } from "../lib/errors.ts";
import { authorDefaults, type JSONSchemaObject } from "@appstrate/core/form";

/**
 * The layers of one run's input, in precedence order. Every field is
 * optional: an origin that has no such layer (an inline run has no stored
 * editor defaults, a manual run has no schedule) simply omits it.
 */
export interface InputLayers {
  /** `manifest.input.schema` — its `default` keywords are the author layer. */
  schema?: JSONSchemaObject | undefined;
  /**
   * `application_packages.input_settings.values` — values the editor stored
   * once.
   */
  editorDefaults?: Record<string, unknown> | undefined;
  /** `application_packages.input_settings.locked` — fields no caller may override. */
  lockedFields?: readonly string[] | undefined;
  /** `package_schedules.input` — values frozen on a scheduled trigger. */
  scheduleValues?: Record<string, unknown> | undefined;
  /** What the caller sent on this launch. */
  callerInput?: Record<string, unknown> | undefined;
}

/**
 * Refuse an attempt to set a locked field.
 *
 * Locking a field means its value is decided by the editor, so a launch that
 * tries to set it is not silently ignored — silently dropping a value the
 * caller sent is how a run does something other than what was asked. The
 * offending field is named so the caller can fix the request.
 */
export function assertFieldsUnlocked(
  values: Record<string, unknown> | undefined,
  lockedFields: readonly string[] | undefined,
  origin: "input" | "schedule input" = "input",
): void {
  if (!values || !lockedFields || lockedFields.length === 0) return;
  const locked = new Set(lockedFields);
  for (const key of Object.keys(values)) {
    if (!locked.has(key)) continue;
    throw new ApiError({
      status: 400,
      code: "locked_input_field",
      title: "Locked Input Field",
      detail: `Field '${key}' is locked on this agent and cannot be set at launch — remove it from the ${origin}.`,
      param: `input.${key}`,
    });
  }
}

/**
 * Collapse the four layers into the input a run executes with.
 *
 * Throws `ApiError(400, "locked_input_field")` when the caller's input or a
 * schedule's frozen values name a locked field.
 */
export function resolveEffectiveInput(layers: InputLayers): Record<string, unknown> {
  assertFieldsUnlocked(layers.scheduleValues, layers.lockedFields, "schedule input");
  assertFieldsUnlocked(layers.callerInput, layers.lockedFields, "input");

  return {
    ...authorDefaults(layers.schema),
    ...(layers.editorDefaults ?? {}),
    ...(layers.scheduleValues ?? {}),
    ...(layers.callerInput ?? {}),
  };
}

/**
 * Drop the locked keys from a set of values.
 *
 * Used for a `rerun_from` replay: the caller sent a run id, not values, so the
 * prior run's snapshot is not "the caller setting a field". Replaying it
 * verbatim would 400 on every field locked since that run; dropping the locked
 * keys lets the replay resolve them from the current editor value, which is
 * exactly what a fresh launch would do.
 */
export function withoutLockedFields(
  values: Record<string, unknown>,
  lockedFields: readonly string[] | undefined,
): Record<string, unknown> {
  if (!lockedFields || lockedFields.length === 0) return values;
  const locked = new Set(lockedFields);
  return Object.fromEntries(Object.entries(values).filter(([key]) => !locked.has(key)));
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
