// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { z } from "zod";

const eeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_ID_STARTER: z.string().min(1),
  STRIPE_PRICE_ID_PRO: z.string().min(1),

  // EE runs its OWN database, fully separate from the platform's. Billing
  // data never shares a database with OSS tables; the platform's `llm_usage`
  // ledger is read through the `services.usage` cursor, not a cross-DB join.
  // Required when the EE module is loaded.
  EE_DATABASE_URL: z.string().min(1),

  // Billing sweeper — the EE metering consumer. Each tick advances a
  // serial-`id` watermark through the platform's append-only `llm_usage`
  // ledger, claims platform-provided rows into `ee_billed_llm_usage`, and
  // debits credits. A failed pass advances nothing; the next tick retries.
  //
  // INTERVAL is the sweep cadence, BATCH_SIZE the max rows per tick. Defaults
  // tuned for a small deployment: 5-min cadence, 100 rows per tick. Set
  // INTERVAL=0 to disable.
  EE_RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  // Max 1000 is the platform's `usage.list` hard ceiling (LLM_USAGE_LIST_MAX_LIMIT):
  // the cursor read is capped there server-side, so a larger batch would silently
  // cap AND make the sweeper's "consumer is behind" backlog warning
  // (`processed >= batchSize`) dead code (processed can never reach batchSize).
  EE_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

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
  // MAX 500 makes forward progress STRUCTURAL rather than merely likely. A pass
  // reads `replaySpan + BATCH_SIZE` rows capped at the platform's 1000-row
  // ceiling, and at most `replaySpan` (≤ this value) of them can fall in the
  // replay region — so forward capacity never drops below 500 rows no matter how
  // high BATCH_SIZE is set. Raising BATCH_SIZE therefore cannot starve the
  // replay window, and raising this cannot wedge the sweeper: the two knobs are
  // independent by construction, not by operator discipline.
  //
  // 0 disables replay, restoring the pre-fix cursor AND its silent-loss window.
  // That is an emergency escape hatch, not a tuning knob.
  EE_RECONCILIATION_REPLAY_WINDOW: z.coerce.number().int().min(0).max(500).default(200),
});

export type EeEnv = z.infer<typeof eeEnvSchema>;

let _env: EeEnv | null = null;

export function getEeEnv(): EeEnv {
  if (!_env) {
    _env = eeEnvSchema.parse(process.env);
  }
  return _env;
}

/**
 * Test-only — drop the cached parsed env so the next `getEeEnv()` re-
 * reads `process.env`. Lets a single test file flip env vars between
 * cases without spawning a fresh process.
 */
export function _resetEeEnvForTests(): void {
  _env = null;
}
