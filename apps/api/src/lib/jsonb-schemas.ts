/**
 * Zod validators for the JSONB columns that previously accepted any
 * `Record<string, unknown>` from internal callers. The columns store data
 * produced by trusted services (run finalize, hooks, sinks), but lack of
 * structural enforcement at the write boundary means a single rogue caller
 * can poison the column with `Date` objects, functions, or oversized blobs
 * — all undetectable until a downstream read explodes.
 *
 * Each schema asserts JSON-safety + a soft byte cap on the JSON-stringified
 * payload. Callers `.parse()` to throw on invalid input (good for the create
 * / update boundaries) or `.safeParse()` to log-and-skip on the high-volume
 * log path.
 */

import { z } from "zod";

const KB = 1024;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function withByteCap(maxBytes: number) {
  return (value: unknown, ctx: z.RefinementCtx): void => {
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size > maxBytes) {
      ctx.addIssue({
        code: "custom",
        message: `JSON payload is ${size} bytes; max is ${maxBytes}`,
      });
    }
  };
}

/** `runs.metadata` — opaque payload returned by the `afterRun` hook. */
export const runMetadataSchema = z
  .record(z.string(), jsonValueSchema)
  .superRefine(withByteCap(8 * KB));

/** `runs.config` — snapshot of the effective agent config at run creation. */
export const runConfigSchema = z
  .record(z.string(), jsonValueSchema)
  .superRefine(withByteCap(16 * KB));

/** `run_logs.data` — per-event payload (progress, result, system events). */
export const runLogDataSchema = z
  .record(z.string(), jsonValueSchema)
  .superRefine(withByteCap(32 * KB));

/**
 * `package_persistence.content` — checkpoint / pinned-slot / memory
 * payload. Memories may be a plain string (the AFPS `note` tool path);
 * checkpoints + pinned slots are typically structured objects / arrays.
 * Validated as any JSON-safe value capped at 64 KB per row — large
 * enough for rich agent state, small enough that a runaway writer
 * cannot single-handedly poison a workspace.
 */
export const packagePersistenceContentSchema = jsonValueSchema.superRefine(withByteCap(64 * KB));
