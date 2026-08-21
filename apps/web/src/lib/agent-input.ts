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
export interface InputFieldPartition {
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
 * Compact, unambiguous rendering of a resolved value for a read-only display.
 * `undefined` means no layer supplies one.
 */
export function formatInputValue(value: unknown): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}
