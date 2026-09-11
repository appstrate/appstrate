// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { z } from "zod";

/**
 * The platform's `usage.list` hard ceiling (`LLM_USAGE_LIST_MAX_LIMIT`). A read
 * asking for more is capped server-side, so the sweep clamps here explicitly
 * rather than requesting a limit it will not get.
 */
export const LEDGER_LIST_MAX_LIMIT = 1000;

/**
 * This module's environment contract. Exported for one reader no import graph shows: the
 * platform's env gates (`scripts/verify-env-docs.ts`, `scripts/verify-compose-defaults.ts`)
 * glob `packages/module-<id>/src/env.ts` and load it through a COMPUTED `import()` — a
 * literal specifier would be an Apache-2.0 file naming this package, which
 * `verify-module-isolation.ts` refuses.
 *
 * @gateImport
 */
export const eeEnvSchema = z
  .object({
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PRICE_ID_STARTER: z.string().min(1),
    STRIPE_PRICE_ID_PRO: z.string().min(1),

    // Billing sweeper — the EE metering consumer. Each tick advances a
    // serial-`id` watermark through the platform's append-only `llm_usage`
    // ledger, claims platform-provided rows into `ee_billed_llm_usage`, and
    // debits credits. A failed pass advances nothing; the next tick retries.
    //
    // INTERVAL is the sweep cadence, BATCH_SIZE the max rows per tick. Defaults
    // tuned for a small deployment: 5-min cadence, 100 rows per tick.
    //
    // INTERVAL=0 pauses METERING only; the tick's maintenance half keeps its own
    // timer (see `runMaintenance` in billing/billing-sweeper.ts).
    EE_RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
    EE_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).default(100),

    // How far BELOW the watermark every sweep pass re-reads the ledger.
    //
    // WHY THIS EXISTS — a PostgreSQL `serial` id is assigned at INSERT and becomes
    // visible at COMMIT, and those two orders are NOT the same. Transaction A can
    // take id 100 and commit AFTER transaction B took id 101 and committed. A pass
    // landing in that window sees 101, bills it, and advances the watermark past
    // 100 — after which `WHERE id > watermark` can never return row 100 again. It
    // is never billed and nothing logs it: silent revenue loss, no alarm. Scanning
    // from `watermark − REPLAY_WINDOW` closes that window. This is cheap and safe
    // ONLY because `ee_billed_llm_usage` is the arbiter: a re-read row that was
    // already claimed debits nothing (`ON CONFLICT DO NOTHING RETURNING`) and
    // claims are never purged. DO NOT "optimize" the re-read away because it looks
    // redundant — the redundancy IS the fix, and what it prevents is silent.
    //
    // DEFAULT 200 — the window must exceed the ids OTHER transactions can burn
    // while one insert's transaction still holds its uncommitted id. Two of the
    // platform's three ledger producers (the inference proxy and the chat seam)
    // insert autonomously — a single statement, no surrounding transaction — so
    // their exposure is one statement's own commit. Only the runner ingestion path
    // holds an id across further work, and that transaction is a 2-4 statement CAS
    // with no external I/O. Realistic exposure is therefore milliseconds: even a
    // pathological one-second straggler would have to coincide with ~200 ledger
    // appends per second to overflow 200. A smaller value would already be
    // correct; 200 buys a 10-100x margin for one extra indexed range scan of
    // already-claimed rows every 5 minutes, which is the cheapest insurance in
    // this module.
    //
    // This sizes the VISIBILITY RACE, not the lifetime of a run — and that is only
    // true because of the head-of-line stall. A replayed row that is still
    // unsettled stalls the frontier, which holds the watermark in place, so the
    // row cannot age out of the window while it waits: its distance to the
    // watermark stops growing the moment it is seen. Skip unsettled rows in the
    // replay region instead and this value would have to exceed the ledger appends
    // of the LONGEST run — unbounded, and unknowable.
    //
    // MAX 500 floors forward capacity at half the read budget however the other
    // knob is set; the cross-field rule below makes it exactly BATCH_SIZE.
    //
    // 0 disables replay, restoring the pre-fix cursor AND its silent-loss window.
    // That is an emergency escape hatch, not a tuning knob.
    EE_RECONCILIATION_REPLAY_WINDOW: z.coerce.number().int().min(0).max(500).default(200),

    // How long the sweep may have been ABSENT before it refuses to resume over the
    // gap it left. The predicate is on `assertCursorResumable` in
    // `billing/billing-sweeper.ts`.
    //
    // DEFAULT 86400 (a day). A sweep that has not confirmed the watermark in 24
    // hours on a platform that kept metering was not running. 0 disables the
    // check and resumes over any gap — the "bill it, whatever its size" answer.
    EE_RECONCILIATION_MAX_GAP_SECONDS: z.coerce.number().int().min(0).default(86400),
  })
  // The two knobs SHARE one read budget (a pass reads replay ON TOP of batch and
  // is capped at LEDGER_LIST_MAX_LIMIT). Rejected at boot rather than clamped: a
  // silently clamped batch makes the drain loop's `processed >= batchSize` gate
  // unreachable and its own warning dead with it.
  .refine(
    (env) =>
      env.EE_RECONCILIATION_REPLAY_WINDOW + env.EE_RECONCILIATION_BATCH_SIZE <=
      LEDGER_LIST_MAX_LIMIT,
    {
      message: `EE_RECONCILIATION_BATCH_SIZE + EE_RECONCILIATION_REPLAY_WINDOW must not exceed ${LEDGER_LIST_MAX_LIMIT}, the platform's usage.list ceiling — a pass reads the replay window ON TOP of the batch, so a larger sum shrinks the forward slice below the batch size instead of reading more`,
      path: ["EE_RECONCILIATION_BATCH_SIZE"],
    },
  );

export type EeEnv = z.infer<typeof eeEnvSchema>;

let _env: EeEnv | null = null;

export function getEeEnv(): EeEnv {
  if (!_env) {
    _env = eeEnvSchema.parse(process.env);
  }
  return _env;
}

/**
 * One line naming every environment variable {@link getEeEnv} rejected, and why
 * — `STRIPE_SECRET_KEY (Required), STRIPE_PRICE_ID_PRO (…)`. A boot crash has to
 * say WHICH of the module's variables is wrong; "not configured" sends an
 * operator to read the schema.
 */
export function describeEnvIssues(err: unknown): string {
  if (!(err instanceof z.ZodError)) return err instanceof Error ? err.message : String(err);
  return err.issues.map((issue) => `${issue.path.join(".")} (${issue.message})`).join(", ");
}

/**
 * Test-only — drop the cached parsed env so the next `getEeEnv()` re-
 * reads `process.env`. Lets a single test file flip env vars between
 * cases without spawning a fresh process.
 */
export function _resetEeEnvForTests(): void {
  _env = null;
}
