// SPDX-License-Identifier: Apache-2.0

/**
 * Tier-aware test guards.
 *
 * The suite runs in two modes (see test/setup/preload.ts):
 *   - tier3 (default, CI): real PostgreSQL + Redis + MinIO + DinD.
 *   - tier0 (`TEST_TIER=0`, fast dev): PGlite + in-memory infra + FS storage.
 *
 * A handful of tests assert on behaviour that only a real external service
 * provides (BullMQ repeatable-job semantics, the Docker Engine API, S3). Those
 * use the `*RequiresRedis|Docker|S3` guards below so they run in tier3/CI and
 * auto-skip in tier0 instead of failing against the in-memory fallbacks.
 *
 * Docker (DinD) tests are additionally opt-in: they are heavy (~16s for the
 * Docker Engine API suite alone), so a plain `bun test` on a dev machine skips
 * them by default. Enable them locally with `TEST_DOCKER=1` (or the root
 * `bun run test:docker` script). CI always runs them — GitHub Actions sets
 * `CI=true` automatically. tier0 never runs them (no DinD is provisioned).
 *
 * Resource presence is read from `process.env` (the preload mutates it before
 * any test imports run), matching how `apps/api/src/infra/mode.ts` decides
 * which adapter to load at runtime.
 */
import { describe, it } from "bun:test";

/** True when running the fast in-memory tier (no external services). */
export const isTier0 = process.env.TEST_TIER === "0";

const hasRedis = !!process.env.REDIS_URL;
const hasS3 = !!process.env.S3_BUCKET;
// External PostgreSQL (vs embedded PGlite). Needed by tests that exercise the
// postgres-only migration path (drizzle schema-qualified tracking tables) or
// spawn a subprocess that must share the DB (PGlite is single-process / a
// throwaway temp dir, so a child process can't attach to it).
const hasExternalDb = !!process.env.DATABASE_URL;
// Docker (DinD) is only provisioned by the tier3 preload, and the tests that
// exercise it are slow — opt-in locally (TEST_DOCKER=1), always on in CI.
const hasDocker = !isTier0 && (process.env.TEST_DOCKER === "1" || process.env.CI === "true");

// Third-party CI systems often set `CI=1` (or another truthy value) where
// GitHub Actions sets `CI=true` — under those, DinD tests silently skip and
// the run looks green while exercising less. Surface the gap once so a fork's
// CI maintainer knows to set TEST_DOCKER=1 (console is fine here: this is
// test-harness diagnostics for a human terminal, not platform runtime code).
if (!isTier0 && !hasDocker && process.env.CI && process.env.CI !== "true") {
  console.warn(
    `⚠ CI=${process.env.CI} detected (not "true") — Docker/DinD tests will be SKIPPED. ` +
      "Set TEST_DOCKER=1 to run them in this CI system.",
  );
}

/** `describe`/`it` that skip unless a real Redis is configured. */
export const describeRequiresRedis = describe.skipIf(!hasRedis);
export const itRequiresRedis = it.skipIf(!hasRedis);

/** `describe`/`it` that skip unless the Docker Engine API (DinD) is available. */
export const describeRequiresDocker = describe.skipIf(!hasDocker);
export const itRequiresDocker = it.skipIf(!hasDocker);

/** `describe`/`it` that skip unless an S3-compatible store is configured. */
export const describeRequiresS3 = describe.skipIf(!hasS3);
export const itRequiresS3 = it.skipIf(!hasS3);

/** `describe`/`it` that skip unless an external PostgreSQL is configured (not PGlite). */
export const describeRequiresPostgres = describe.skipIf(!hasExternalDb);
export const itRequiresPostgres = it.skipIf(!hasExternalDb);
