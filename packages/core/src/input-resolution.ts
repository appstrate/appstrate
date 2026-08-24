// Copyright 2025-2026 Appstrate
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
 * The layers, last one wins:
 *
 *   author default   (manifest `input.schema` JSON Schema `default` keyword)
 *     -> editor default   (`application_packages.input_settings.values`)
 *       -> one overlay per further source, in the order the caller lists them
 *
 * The merge is a shallow per-property overlay: a layer either supplies a
 * top-level property or it does not. There is no deep merge — a property's
 * value is owned by exactly one layer, which is what makes "which layer did
 * this come from" answerable at every call site.
 *
 * ## Why the overlays are a list and not two named fields
 *
 * The two hosts do NOT have the same number of layers. The platform resolves
 * a scheduled trigger's frozen values (`package_schedules.input`) UNDER the
 * caller's launch input; the CLI (`appstrate run --local`) has no schedules at
 * all, so its topmost layer is the caller and nothing else. A named
 * `scheduleValues` field would leave the CLI passing a field it can never fill
 * — a shape that lies about what a local run is made of. Each host instead
 * lists exactly the overlays it has, and each one names its own origin so the
 * refusal below can quote it.
 *
 * ## Why the error is injected
 *
 * Refusing a locked field is a resolution rule, but the *shape* of the refusal
 * belongs to the host: `apps/api` owes the caller its `ApiError(400,
 * "locked_input_field")` problem document, the CLI owes its own error type on
 * a terminal. Core owns the rule and asks the host for the error to throw, so
 * neither host has to re-derive the rule to keep its own error surface.
 */

import { authorDefaults, type JSONSchemaObject } from "./form.ts";

/**
 * Where an overlay's values came from. Quoted verbatim in the locked-field
 * refusal, so it reads as the thing the caller must edit ("remove it from the
 * schedule input").
 */
export type InputOverlayOrigin = "schedule input" | "input";

/**
 * One source of values layered ABOVE the editor's stored values, and therefore
 * subject to the editor's locks.
 */
export interface InputOverlay {
  /** Named in the refusal when this overlay sets a locked field. */
  readonly origin: InputOverlayOrigin;
  /** The values this source supplies; `undefined` when it supplied none. */
  readonly values: Record<string, unknown> | undefined;
}

/**
 * Builds the error thrown when an overlay sets a locked field. Supplied by the
 * host so the refusal carries the host's own error type.
 */
export type LockedFieldErrorFactory = (field: string, origin: InputOverlayOrigin) => Error;

/** The layers of one run's input, in precedence order. */
export interface InputLayers {
  /** `manifest.input.schema` — its `default` keywords are the author layer. */
  schema?: JSONSchemaObject | undefined;
  /**
   * `application_packages.input_settings.values` — values the editor stored
   * once. Absent for a target with no application row behind it.
   */
  editorDefaults?: Record<string, unknown> | undefined;
  /** `application_packages.input_settings.locked` — fields no overlay may set. */
  lockedFields?: readonly string[] | undefined;
  /** Sources above the editor layer, lowest precedence first. */
  overlays: readonly InputOverlay[];
  /** Host-supplied error for a locked field an overlay tried to set. */
  lockedFieldError: LockedFieldErrorFactory;
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
  overlay: InputOverlay,
  lockedFields: readonly string[] | undefined,
  lockedFieldError: LockedFieldErrorFactory,
): void {
  if (!overlay.values || !lockedFields || lockedFields.length === 0) return;
  const locked = new Set(lockedFields);
  for (const key of Object.keys(overlay.values)) {
    if (locked.has(key)) throw lockedFieldError(key, overlay.origin);
  }
}

/**
 * Collapse the layers into the input a run executes with.
 *
 * Throws whatever `lockedFieldError` builds when an overlay names a locked
 * field.
 */
export function resolveEffectiveInput(layers: InputLayers): Record<string, unknown> {
  for (const overlay of layers.overlays) {
    assertFieldsUnlocked(overlay, layers.lockedFields, layers.lockedFieldError);
  }

  const resolved: Record<string, unknown> = {
    ...authorDefaults(layers.schema),
    ...(layers.editorDefaults ?? {}),
  };
  for (const overlay of layers.overlays) {
    Object.assign(resolved, overlay.values ?? {});
  }
  return resolved;
}

/**
 * Drop the locked keys from a set of values.
 *
 * Used wherever values are REPLAYED rather than set: a `rerun_from` replay
 * (the caller sent a run id, not values), a schedule saved before a field was
 * locked, a launch form pre-fill. Replaying them verbatim would be refused on
 * every field locked since; dropping the locked keys lets them resolve from
 * the current editor value, which is exactly what a fresh launch would do.
 */
export function withoutLockedFields(
  values: Record<string, unknown>,
  lockedFields: readonly string[] | undefined,
): Record<string, unknown> {
  if (!lockedFields || lockedFields.length === 0) return values;
  const locked = new Set(lockedFields);
  return Object.fromEntries(Object.entries(values).filter(([key]) => !locked.has(key)));
}
