// SPDX-License-Identifier: Apache-2.0

/**
 * Offboarding sweeper for personal spaces.
 *
 * `removeMember` stamps `spaces.orphaned_at` instead of deleting the space its
 * departing member owned: for 30 days an owner or admin can still convert it to
 * a team space and keep what is in it, and a re-invite inside the window hands
 * it back untouched. This hourly job is what closes that window
 * (`PERSONAL_SPACE_GRACE_DAYS`, RBAC spec §3.6).
 *
 * A COLUMN plus a sweeper, rather than a job row, for the same reason
 * `organizations.deleting_at` is one: `storage_deletion_jobs` is a queue of S3
 * objects, not a generic scheduler, and the reservation belongs on the row
 * whose lifetime it decides.
 *
 * `POST /api/spaces/{id}/sweep-now` runs {@link emptyAndDeletePersonalSpace} on
 * ONE space through the same path, so an administrator never has to wait for
 * this job — and this job is not the only tested route into that routine.
 */

import { createQueue } from "../infra/queue/index.ts";
import type { JobQueue } from "../infra/queue/index.ts";
import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { emptyAndDeletePersonalSpace, listSweepablePersonalSpaces } from "./spaces.ts";

interface SweepResult {
  sweptSpaces: number;
  failedSpaces: number;
}

/**
 * Empty and delete every orphaned personal space whose window has closed.
 *
 * One space at a time, each in its own transaction and each logged: an
 * organization's worth of drafts is not a single unit of work, and a space that
 * refuses (a package that cannot be re-homed, a storage enqueue that fails)
 * must not hold back the rest. A failure is left for the next pass — every step
 * of the routine is idempotent, so retrying costs nothing.
 *
 * Safe to call outside a BullMQ job context; the tests invoke it directly.
 */
export async function sweepOrphanedPersonalSpaces(now = new Date()): Promise<SweepResult> {
  const due = await listSweepablePersonalSpaces(now);
  if (due.length === 0) return { sweptSpaces: 0, failedSpaces: 0 };

  let sweptSpaces = 0;
  let failedSpaces = 0;
  for (const space of due) {
    try {
      const counts = await emptyAndDeletePersonalSpace(space.orgId, space.id);
      sweptSpaces++;
      logger.info("Swept an orphaned personal space", {
        spaceId: space.id,
        orgId: space.orgId,
        ownerUserId: space.ownerUserId,
        ...counts,
      });
    } catch (err) {
      failedSpaces++;
      logger.error("Failed to sweep an orphaned personal space", {
        spaceId: space.id,
        orgId: space.orgId,
        error: getErrorMessage(err),
      });
    }
  }

  logger.info("Personal-space sweep finished", { sweptSpaces, failedSpaces, due: due.length });
  return { sweptSpaces, failedSpaces };
}

// ---------------------------------------------------------------------------
// BullMQ worker
// ---------------------------------------------------------------------------

const QUEUE_NAME = "personal-space-sweeper";
const JOB_NAME = "sweep-orphaned-personal-spaces";
const SCHEDULER_ID = "personal-space-sweeper-hourly";
const HOURLY_CRON = "17 * * * *"; // off the hour, away from the other schedulers.

let sweeperQueue: JobQueue<Record<string, never>> | null = null;

async function getQueue(): Promise<JobQueue<Record<string, never>>> {
  if (!sweeperQueue) {
    sweeperQueue = await createQueue<Record<string, never>>(QUEUE_NAME);
  }
  return sweeperQueue;
}

/** Start the worker + register the hourly repeatable scheduler. */
export async function initPersonalSpaceSweeperWorker(): Promise<void> {
  const queue = await getQueue();

  queue.process(
    async () => {
      await sweepOrphanedPersonalSpaces();
    },
    { concurrency: 1 },
  );

  await queue.upsertScheduler(
    SCHEDULER_ID,
    { pattern: HOURLY_CRON, tz: "UTC" },
    { name: JOB_NAME, data: {} },
  );

  logger.info("Personal-space sweeper started", { cron: HOURLY_CRON });
}

/** Graceful shutdown — part of the boot.ts shutdown ordering. */
export async function shutdownPersonalSpaceSweeperWorker(): Promise<void> {
  await sweeperQueue?.shutdown();
  sweeperQueue = null;
}
