// SPDX-License-Identifier: Apache-2.0

/**
 * Client view of input resolution. The server resolves
 * `schema.default` → stored value (per-space `values`) → schedule value → caller input, and refuses
 * a locked field (400 `locked_input_field`). Launch surfaces derive their display states from
 * `values` + `locked_fields` via `partitionInputFields` (`@appstrate/core/input-resolution`).
 */

import { jsonText } from "@appstrate/afps-shared/json-text";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import {
  resolvedInputDefaults,
  withoutLockedFields,
  type AgentInputSettings,
} from "@appstrate/core/input-resolution";

/** Narrows a wrapper to `keys` with its per-field metadata; a `required` naming an absent property would make the subset unsatisfiable, so it is dropped. `null` when empty. */
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
  // Carry only the definition containers a kept property may `$ref` (RJSF
  // throws without them). Other root keywords (`allOf`, `dependentRequired`,
  // `minProperties`, …) can name dropped keys and make the subset unsatisfiable.
  const definitions = Object.fromEntries(
    Object.entries(wrapper.schema).filter(([key]) => key === "$defs" || key === "definitions"),
  );
  const schema: JSONSchemaObject = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...definitions,
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

export function hasInputFields(wrapper: SchemaWrapper | undefined): boolean {
  return !!wrapper?.schema?.properties && Object.keys(wrapper.schema.properties).length > 0;
}

/** Seed for a launch form: author `default` overlaid by the stored value, then `seed` (a re-run's input or a schedule's frozen values). Locked keys are dropped (the run route refuses them). */
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
 * Seed for a form whose SCHEMA can change under it (the run-with-options version selector). Stored
 * `values` are version-independent but an author `default` belongs to the launched version;
 * seeding it would freeze the version selected at open time, so the wrapper supplies defaults itself.
 */
export function storedInputValues(settings: AgentInputSettings): Record<string, unknown> {
  return withoutLockedFields(settings.values, settings.locked_fields);
}

/** Compact rendering of a resolved value for read-only display; `undefined` = no layer supplies one. */
export function formatInputValue(value: unknown): string {
  if (value === undefined) return "—";
  return jsonText(value);
}

/** Structural equality: values are arbitrary JSON, so `===` would freeze identical values onto the caller's layer. */
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
 * The values THIS layer actually decides. The form is seeded with each field's resolved value;
 * submitting it verbatim would claim all of them on a layer that outranks their source, freezing
 * them. Keeps only keys differing from layers 1+2, which still supply the CURRENT value at launch.
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
