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
