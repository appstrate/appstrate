// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side view of the platform's input resolution.
 *
 * An AFPS agent declares ONE parameter schema (`input`). Whether a field is
 * asked at every launch or decided once by the editor is a platform fact, not
 * a manifest fact: it is carried by the per-application `values` (layer 2) and
 * `locked_fields` alongside the schema. The server resolves
 *
 *   author default (`schema.default`) → stored value → schedule value → caller input
 *
 * and refuses a caller that sets a locked field (400 `locked_input_field`).
 *
 * The launch surfaces derive their three display states from exactly those two
 * fields, so the form can never offer to set something the run would reject.
 */

import {
  authorDefaults,
  getOrderedKeys,
  type JSONSchemaObject,
  type SchemaWrapper,
} from "@appstrate/core/form";

/** The per-application layer that rides next to the schema on `AgentDetail.input`. */
export interface AgentInputSettings {
  /** Values the editor stored once for this application. */
  values: Record<string, unknown>;
  /** Fields no caller may set at launch. */
  locked_fields: string[];
}

/**
 * The three display states of a launch form, as ordered key lists.
 *
 * - `locked` — shown read-only with its resolved value; never submitted.
 * - `prefilled` — has a value behind it already (author `default` or a stored
 *   value), so it is folded into the "advanced" section, pre-filled.
 * - `prompted` — nothing decides it yet; asked at the top level.
 */
interface InputFieldPartition {
  locked: string[];
  prefilled: string[];
  prompted: string[];
}

/** Every top-level key of the input schema, in presentation order. */
function orderedKeys(wrapper: SchemaWrapper | undefined): string[] {
  if (!wrapper?.schema?.properties) return [];
  return getOrderedKeys(wrapper.schema, wrapper.property_order);
}

/**
 * The value each field resolves to before the caller says anything: the
 * author's `default` overlaid by the editor's stored value. Same overlay the
 * server applies for layers 1 and 2 — a field neither layer supplies stays
 * absent rather than becoming `null`.
 */
export function resolvedInputDefaults(
  wrapper: SchemaWrapper | undefined,
  settings: AgentInputSettings,
): Record<string, unknown> {
  return { ...authorDefaults(wrapper?.schema), ...settings.values };
}

/** Split the schema's fields into the three launch-form display states. */
export function partitionInputFields(
  wrapper: SchemaWrapper | undefined,
  settings: AgentInputSettings,
): InputFieldPartition {
  const locked = new Set(settings.locked_fields);
  const decided = resolvedInputDefaults(wrapper, settings);
  const partition: InputFieldPartition = { locked: [], prefilled: [], prompted: [] };
  for (const key of orderedKeys(wrapper)) {
    if (locked.has(key)) partition.locked.push(key);
    else if (decided[key] !== undefined) partition.prefilled.push(key);
    else partition.prompted.push(key);
  }
  return partition;
}

/**
 * Narrow a wrapper to `keys`, carrying every piece of per-field metadata the
 * renderer needs (file constraints, UI hints, order) and dropping `required`
 * entries for fields the subset does not contain — a `required` naming an
 * absent property makes the whole subset unsatisfiable.
 *
 * Returns `null` when the subset is empty, so a caller can skip the form
 * entirely instead of rendering an empty one.
 */
export function subsetWrapper(
  wrapper: SchemaWrapper | undefined,
  keys: string[],
): SchemaWrapper | null {
  if (!wrapper?.schema?.properties || keys.length === 0) return null;
  const kept = new Set(keys);
  const properties = Object.fromEntries(
    Object.entries(wrapper.schema.properties).filter(([key]) => kept.has(key)),
  );
  if (Object.keys(properties).length === 0) return null;
  const required = (wrapper.schema.required ?? []).filter((key) => key in properties);
  const schema: JSONSchemaObject = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
  const fileConstraints = pickKeys(wrapper.file_constraints, kept);
  const uiHints = pickKeys(wrapper.ui_hints, kept);
  const order = (wrapper.property_order ?? []).filter((key) => key in properties);
  return {
    schema,
    ...(fileConstraints ? { file_constraints: fileConstraints } : {}),
    ...(uiHints ? { ui_hints: uiHints } : {}),
    ...(order.length > 0 ? { property_order: order } : {}),
  };
}

function pickKeys<T>(
  map: Record<string, T> | undefined,
  keep: Set<string>,
): Record<string, T> | undefined {
  if (!map) return undefined;
  const out = Object.fromEntries(Object.entries(map).filter(([key]) => keep.has(key)));
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Drop the locked keys from a set of values.
 *
 * Mirrors the server's `withoutLockedFields`: a re-run replaying an older run's
 * input, or a schedule saved before a field was locked, must not send a value
 * the launch would now refuse — it resolves from the editor's value instead.
 */
export function withoutLockedFields(
  values: Record<string, unknown>,
  lockedFields: readonly string[],
): Record<string, unknown> {
  if (lockedFields.length === 0) return values;
  const locked = new Set(lockedFields);
  return Object.fromEntries(Object.entries(values).filter(([key]) => !locked.has(key)));
}

/** Whether the schema declares anything at all — lets a caller skip the section. */
export function hasInputFields(wrapper: SchemaWrapper | undefined): boolean {
  return !!wrapper?.schema?.properties && Object.keys(wrapper.schema.properties).length > 0;
}

/**
 * Seed for a launch form's editable values.
 *
 * Pre-fills every field that already has a value behind it (author `default`
 * overlaid by the editor's stored value), then applies `seed` — a re-run's
 * previous input, or a schedule's frozen values. Locked keys are dropped in
 * both directions: the run route refuses them (400 `locked_input_field`), so
 * offering one for edit would build a request that cannot succeed.
 */
export function initialInputValues(
  wrapper: SchemaWrapper | undefined,
  settings: AgentInputSettings,
  seed?: Record<string, unknown>,
): Record<string, unknown> {
  return withoutLockedFields(
    { ...resolvedInputDefaults(wrapper, settings), ...(seed ?? {}) },
    settings.locked_fields,
  );
}

/**
 * Seed for a launch form whose SCHEMA can still change under it — the
 * run-with-options modal, where the version selector re-pins the wrapper after
 * the state has been created.
 *
 * The two layers behind a field have different lifetimes: the editor's stored
 * `values` live on the application row and are version-independent, while an
 * author `default` belongs to the schema of the version being launched. Seeding
 * a default would therefore freeze the version selected at open time onto every
 * later pick; the version-pinned wrapper supplies its own defaults through the
 * form's normal rendering path instead. Locked keys are dropped, as everywhere
 * else: the run route refuses them (400 `locked_input_field`).
 */
export function storedInputValues(settings: AgentInputSettings): Record<string, unknown> {
  return withoutLockedFields(settings.values, settings.locked_fields);
}

/**
 * Compact, unambiguous rendering of a resolved value for a read-only display.
 * `undefined` means no layer supplies one.
 */
export function formatInputValue(value: unknown): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Structural equality for two resolved input values.
 *
 * Input values are arbitrary JSON — objects, arrays, file-reference strings —
 * so `===` would report two structurally identical values as different and
 * freeze them onto the caller's layer. Small enough to keep local; a
 * dependency for it would cost more than it carries.
 */
function sameInputValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameInputValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => key in right && sameInputValue(left[key], right[key]));
}

/**
 * The subset of a launch form's values that THIS layer actually decides.
 *
 * A launch form is seeded with the value every field resolves to (author
 * `default` overlaid by the editor's stored value) so the user sees what a
 * launch will use. Submitting that seed back verbatim would claim every one of
 * those values as the caller's own — and on a layer that outranks the ones it
 * was copied from, that turns a display into a permanent freeze: the editor's
 * value could then change forever without the launch following it.
 *
 * So: keep only the keys whose value differs from what layers 1+2 already
 * resolve to. Dropping an unchanged key loses nothing — the same two layers
 * supply it at launch time, and they supply the CURRENT value rather than the
 * one that happened to be resolved when this form was saved. Locked keys are
 * dropped as everywhere else: the launch routes refuse them (400
 * `locked_input_field`).
 */
export function changedInputValues(
  wrapper: SchemaWrapper | undefined,
  settings: AgentInputSettings,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = resolvedInputDefaults(wrapper, settings);
  return withoutLockedFields(
    Object.fromEntries(
      Object.entries(values).filter(([key, value]) => !sameInputValue(value, resolved[key])),
    ),
    settings.locked_fields,
  );
}
