// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-shape rules shared by every surface that can launch a run: the agent run,
 * the inline run (+ validate), the remote run and schedule create/update. A
 * surface that accepts a map imports its rule from here.
 *
 *   - `connection_overrides`: all four take {@link connectionOverridesSchema}
 *     and refuse an undeclared key through {@link connectionOverrideRefusals}.
 *     The remote surface adds a rule of its own in `run-creation.ts`: a remote
 *     run binds one connection per integration (`remote_binds_one_connection`).
 *   - `dependency_overrides`: remote and schedules take
 *     {@link dependencyOverridesSchema}; inline declares none; the agent run
 *     declares a bare record and leaves the VALUE gate to `input-parser.ts`,
 *     the one layer that can name the offending key.
 */

import { z } from "zod";
import {
  collectOverridableDependencyIds,
  parseManifestIntegrations,
} from "@appstrate/core/dependencies";
import type { OverrideRefusalCode } from "@appstrate/core/integration";
import { ApiError, validationFailed, type ValidationFieldError } from "./errors.ts";
import { connectionIdSetSchema } from "./connection-set.ts";
import { isValidDependencyOverride } from "../services/input-parser.ts";

/**
 * Per-integration connection picks: `{ "@scope/integration": ["<connection_id>", ...] }`.
 *
 * The uuid gate keeps a malformed id off the uuid column, where Postgres would
 * reject the query instead of the resolver refusing the pick.
 *
 * It is also owned here rather than delegated to `parseRequestInput`:
 * `POST /api/runs/inline/validate` never calls the parser, so the guard would
 * have no owner there and the validator would disagree with the launch on the
 * same body.
 */
export const connectionOverridesSchema = z.record(z.string(), connectionIdSetSchema);

/**
 * Per-dependency version overrides: `{ "@scope/dep": "draft" | "<spec>" }`.
 * Keys may name a declared skill OR integration; the KEY gate and pin
 * resolution happen later, in `freezeRunSpawnDependencies`.
 *
 * The VALUE gate has to live in the schema for the surfaces that never reach
 * `parseRequestInput`: a schedule resolves its input through
 * `resolveEffectiveInput` + `validateInput` and never calls the parser, so an
 * unresolvable value used to freeze onto the row and fail at EVERY fire
 * instead of at the write.
 */
export const dependencyOverridesSchema = z
  .record(z.string(), z.string())
  .refine(
    (m) => Object.values(m).every(isValidDependencyOverride),
    '`dependency_overrides` values must be "draft" or a valid version spec (semver range or dist-tag)',
  );

/**
 * Refuse a `dependency_overrides` KEY that names nothing the effective
 * manifest declares — `400`, naming the offending key.
 *
 * The rule the schema above cannot state: which ids are legal depends on the
 * agent, not on the shape of the map, so it needs the resolved manifest and
 * cannot be a Zod refinement. It lives HERE, at the wire boundary, rather than
 * only in `freezeRunSpawnDependencies` deep on the run hot path, because every
 * caller that gates AUTHORITY over a `draft` entry sits between the two: with
 * the key gate downstream, a typo in a dependency id comes back as "you may not
 * write that package" instead of "there is no such dependency here", sending
 * its reader after a grant they do not need. FORM comes first — whether the key
 * means anything at all is decided before whose it is — on every surface that
 * launches or schedules a run.
 *
 * The manifest must be the EFFECTIVE one — the definition the launch will
 * actually execute — because a draft and a published version declare different
 * dependencies, and judging against the wrong one either refuses a legal
 * override or admits a dead one.
 */
export function assertDependencyOverrideKeysDeclared(
  manifest: Record<string, unknown>,
  overrides: Readonly<Record<string, string>> | null | undefined,
): void {
  if (!overrides) return;
  const declared = collectOverridableDependencyIds(manifest);
  const unknownKey = Object.keys(overrides).find((key) => !declared.has(key));
  if (unknownKey === undefined) return;
  throw overrideRefusal({
    field: "dependency_overrides",
    key: unknownKey,
    code: "undeclared_dependency_override",
    message: `${unknownKey} is not a skill or integration this agent declares — remove the key`,
  }).error;
}

/** One refused override key: a `validation_failed` item on `<field>.<key>`, whatever the map. */
function overrideRefusal(r: {
  field: "connection_overrides" | "dependency_overrides";
  key: string;
  code: OverrideRefusalCode;
  message: string;
}): OverrideKeyRefusal {
  const item = { field: `${r.field}.${r.key}`, code: r.code, message: r.message };
  return { key: r.key, item, error: validationFailed([item]) };
}

/**
 * Refuses a `connection_overrides` KEY the EFFECTIVE manifest does not declare
 * (`undeclared_connection_override`): the resolver would drop it and bind a lower cascade layer
 * instead. Also `[]`
 * on an integration the manifest marks `required`, which no launch could ever satisfy —
 * the `required_integration_unbound` a pin's `[]` raises, refused here at the write.
 */
export function assertConnectionOverridesAllowed(
  manifest: Record<string, unknown>,
  overrides: Readonly<Record<string, readonly unknown[]>> | null | undefined,
): void {
  const first = connectionOverrideRefusals(manifest, overrides)[0];
  if (first) throw first.error;
}

interface OverrideKeyRefusal {
  key: string;
  /** The entry an accumulating validator collects. */
  item: ValidationFieldError & { code: OverrideRefusalCode };
  /** The 400 a fail-fast surface throws. */
  error: ApiError;
}

/** Every key {@link assertConnectionOverridesAllowed} refuses — undeclared first. */
export function connectionOverrideRefusals(
  manifest: Record<string, unknown>,
  overrides: Readonly<Record<string, readonly unknown[]>> | null | undefined,
): OverrideKeyRefusal[] {
  if (!overrides) return [];
  const declared = parseManifestIntegrations(manifest);
  const ids = new Set(declared.map((entry) => entry.id));
  const undeclared = Object.keys(overrides)
    .filter((key) => !ids.has(key))
    .map((key) =>
      overrideRefusal({
        field: "connection_overrides",
        key,
        code: "undeclared_connection_override",
        message: `${key} is not an integration this agent declares — remove the key`,
      }),
    );
  const emptiedRequired = declared
    .filter((entry) => entry.required === true && overrides[entry.id]?.length === 0)
    .map((entry) =>
      overrideRefusal({
        field: "connection_overrides",
        key: entry.id,
        code: "required_integration_unbound",
        message: `The agent marks ${entry.id} \`required\`, so its set cannot be empty — name at least one connection, or omit the key`,
      }),
    );
  return [...undeclared, ...emptiedRequired];
}
