// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-shape rules shared by every surface that can launch a run.
 *
 * There are four: `POST /api/agents/{scope}/{name}/run`, `POST /api/runs/inline`
 * (+ `/inline/validate`), `POST /api/runs/remote`, and schedule create/update.
 * They deliberately validate the same two maps the same way, and until this
 * module existed they said so in comments instead of in code — `runs.ts` noted
 * `.min(1)` was set "for the same reason it is set on the inline schema below",
 * `schedules.ts` noted it was "for the same reason the run route sets it" and
 * that a second `dependency_overrides` predicate "would be a second opinion",
 * and then wrote one anyway. Three copies of the value rule and two byte-identical
 * refinement messages is how the surfaces stop agreeing.
 *
 * The value-level `dependency_overrides` gate in `input-parser.ts` is NOT a
 * fourth copy and stays where it is: it names the offending KEY and fills the
 * RFC 9457 `param`, which a Zod refinement over the whole map cannot do. It is
 * a better message on the path that can produce it, not a second opinion.
 */

import { z } from "zod";
import { isValidDependencyOverride } from "../services/input-parser.ts";

/**
 * Per-integration connection picks: `{ "@scope/integration": "<connection_id>" }`.
 *
 * `.min(1)` on the VALUE is load-bearing on every surface, and it costs the
 * most on schedules. An empty-string id is FALSY at the resolver's `resolveOne`
 * (`integration-connection-resolver.ts`, layer 4), so the pin is skipped
 * without a trace and the launch falls through to the actor-fallback or dies
 * with a 412 `must_choose_connection`. A schedule replays its frozen map on
 * every tick, so without this the write answers 200 once and every subsequent
 * fire is silently wrong.
 *
 * It is also owned here rather than delegated to `parseRequestInput`:
 * `POST /api/runs/inline/validate` never calls the parser, so the guard would
 * have no owner there and the validator would disagree with the launch on the
 * same body.
 */
export const connectionOverridesSchema = z.record(z.string(), z.string().min(1));

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
