// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-shape rules shared by every surface that can launch a run.
 *
 * There are four: `POST /api/agents/{scope}/{name}/run`, `POST /api/runs/inline`
 * (+ `/inline/validate`), `POST /api/runs/remote`, and schedule create/update.
 * They do NOT all accept both maps — see the breakdown below. What this module
 * is for is that the surfaces which DO accept a given map import its rule from
 * here rather than restating it.
 * Until it existed the rules lived in comments instead of in code: `runs.ts`
 * noted `.min(1)` was set "for the same reason it is set on the inline schema
 * below", `schedules.ts` noted it was "for the same reason the run route sets
 * it" and that a second `dependency_overrides` predicate "would be a second
 * opinion", and then wrote one anyway. Three copies of the value rule and two
 * byte-identical refinement messages is how the surfaces stop agreeing.
 *
 * What each surface actually declares, and why the split is correct:
 *
 *   - `connection_overrides` — agent run, inline (+ validate) and schedules all
 *     take {@link connectionOverridesSchema}. The remote surface declares none,
 *     and `run-creation.ts` relies on that: it passes `runOverrides: null` to
 *     the connection cascade and stamps `connectionOverrides: null` on the row,
 *     so the readiness pass and the snapshot resolve the identical cascade.
 *     Accepting the field here without threading it would break that equality.
 *   - `dependency_overrides` — the remote surface and schedules take
 *     {@link dependencyOverridesSchema}. Inline declares it not at all: it was
 *     accepted and then silently dropped, so since #1187 `.strict()` turns it
 *     into a 400. The agent-run route declares it as a bare
 *     `z.record(z.string(), z.string())` on purpose and defers the VALUE gate
 *     to `input-parser.ts`, which is the only layer that can name the offending
 *     KEY and fill the RFC 9457 `param`. Adopting the shared schema there would
 *     replace a message that points at the bad entry with one that points at
 *     the whole map — a worse error, not a tighter one.
 *
 * So the `input-parser.ts` gate is not a fourth copy of the value rule: it is
 * that rule's only owner on the one path that can afford a better message.
 */

import { z } from "zod";
import { collectOverridableDependencyIds } from "@appstrate/core/dependencies";
import {
  MAX_CONNECTIONS_PER_INTEGRATION,
  normalizeConnectionIds,
} from "@appstrate/core/integration";
import { ApiError } from "./errors.ts";
import { isValidDependencyOverride } from "../services/input-parser.ts";

/**
 * Per-integration connection picks:
 * `{ "@scope/integration": ["<connection_id>", ...] }`.
 *
 * Three bounds, all load-bearing on every surface, and all costing the most on
 * schedules — a schedule replays its frozen map on every tick, so a shape the
 * write accepts and the resolver ignores answers 200 once and fires wrong for
 * ever after:
 *
 *  - `.min(1)` on the ID: an empty-string id resolves to no row at
 *    `resolveOne` (`integration-connection-resolver.ts`), so the pick would be
 *    refused per fire instead of per write.
 *  - `.min(1)` on the ARRAY: an empty set is indistinguishable from "this
 *    layer has no opinion" (`nonEmpty`, same file), so the launch would fall
 *    through to the actor-fallback in silence.
 *  - `.max(MAX_CONNECTIONS_PER_INTEGRATION)`: the cap is a write-time rule
 *    everywhere (pins, org defaults, overrides) — the resolver only echoes a
 *    set a write already validated.
 *  - `normalizeConnectionIds` (core): lowercases every id and refuses a
 *    repeat. The fold is what makes an uppercase id resolve at all — the
 *    resolver keys its lookup on what Postgres returned — and a repeat is a
 *    set whose labels cannot be distinct, so it would 412
 *    `duplicate_connection_label` at every fire. Same helper as the pin and
 *    org-default writes.
 *
 * It is also owned here rather than delegated to `parseRequestInput`:
 * `POST /api/runs/inline/validate` never calls the parser, so the guard would
 * have no owner there and the validator would disagree with the launch on the
 * same body.
 */
export const connectionOverridesSchema = z.record(
  z.string(),
  z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_CONNECTIONS_PER_INTEGRATION)
    .transform((ids, ctx) => {
      const normalized = normalizeConnectionIds(ids);
      if (normalized === null) {
        ctx.addIssue({
          code: "custom",
          message: "`connection_overrides` must not repeat a connection id",
        });
        return z.NEVER;
      }
      return normalized;
    }),
);

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
  throw new ApiError({
    status: 400,
    code: "invalid_request",
    title: "Bad Request",
    detail: `\`dependency_overrides["${unknownKey}"]\` is not a declared skill or integration dependency of this agent`,
  });
}
