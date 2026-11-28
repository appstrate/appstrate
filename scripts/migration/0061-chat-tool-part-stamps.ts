#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0061 — stored chat tool parts rewritten to the two contracts the chat reads now:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0061-chat-tool-part-stamps.ts [--apply]
 *
 * (a) Resolved call space. A successful tool call stored the spaces it acted in as
 * `output.actedSpaceIds`; the chat now keeps them only in `resultProviderMetadata.appstrate.actedSpaceIds`
 * (`appstrateToolPartMetadataSchema`), as it always did for a failure. For each tool part whose output
 * carries the key, a list of strings moves into that metadata (an `actedSpaceIds` already there is kept)
 * and the key leaves the output, as the mapper persists the same call today. Without it an old
 * conversation loses the space badge of its calls.
 *
 * (b) Turn-budget note. The model-facing `[turn budget] …` line was the trailing text block of a tool
 * result, recognised by its text; it is now recognised only by its `_meta` marker. The trailing block of
 * a stored result that starts with that line and carries no marker gets the block `turnBudgetNoteBlock`
 * produces (marker and `assistant` audience). Without it an old result shows the line to its reader.
 *
 * A malformed `actedSpaceIds` (not an array of strings) is removed from the output and stamped nowhere;
 * the summary counts those separately ("dropped").
 *
 * Not a boot guard: not running it changes what an old conversation DISPLAYS, nothing else. The app may
 * keep running. Only `chat_messages.content` is written. `--apply` commits per page of 100 rows: each
 * page is selected FOR UPDATE, rewritten and committed in its own short transaction (`lock_timeout`
 * 5s), so locks are never held across pages. The rewrite is idempotent and keyset-resumable: an
 * interrupted run is simply re-run. The final "left" verification runs outside any write transaction
 * and exits 1 unless nothing is left. Targets `DATABASE_URL` or
 * `PGLITE_DATA_DIR`, exits 2 with neither (`lib/database-target.ts`).
 */

import { parseArgs } from "node:util";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@appstrate/db/client";
import { chatMessages, type ChatMessageContent } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { isTurnBudgetNoteBlock, turnBudgetNoteBlock } from "@appstrate/core/chat-turn-metadata";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";

/** What the old reader took for the note: the trailing block's text started with this. */
const OLD_NOTE_PREFIX = "[turn budget] ";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const isToolPart = (part: Json): boolean =>
  part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-"));

/** The content blocks of a stored result: `{ content: [...] }` or a bare block array. */
function contentOf(output: unknown): unknown[] | undefined {
  if (Array.isArray(output)) return output;
  return isObject(output) && Array.isArray(output.content) ? output.content : undefined;
}

function markNote(blocks: unknown[]): unknown[] | undefined {
  const last = blocks[blocks.length - 1];
  if (
    !isObject(last) ||
    last.type !== "text" ||
    typeof last.text !== "string" ||
    !last.text.startsWith(OLD_NOTE_PREFIX) ||
    isTurnBudgetNoteBlock(last)
  ) {
    return undefined;
  }
  return [...blocks.slice(0, -1), { ...last, ...turnBudgetNoteBlock(last.text) }];
}

/**
 * The parts of one message with both contracts brought to the current form, and how many parts
 * changed for (a), how many malformed `actedSpaceIds` were dropped unstamped, and how many blocks were
 * marked for (b). Pure, so the written shape is tested
 * without a database.
 */
export function rewriteToolPartStamps(parts: readonly unknown[]): {
  parts: unknown[];
  acted: number;
  dropped: number;
  notes: number;
} {
  let acted = 0;
  let dropped = 0;
  let notes = 0;
  const next = parts.map((part) => {
    if (!isObject(part) || !isToolPart(part) || !("output" in part)) return part;
    let result: Json = part;
    let output: unknown = part.output;

    if (isObject(output) && "actedSpaceIds" in output) {
      const { actedSpaceIds, ...rest } = output;
      output = rest;
      if (!isStringArray(actedSpaceIds)) {
        dropped += 1;
      } else {
        acted += 1;
        const meta = isObject(result.resultProviderMetadata) ? result.resultProviderMetadata : {};
        const appstrate = isObject(meta.appstrate) ? meta.appstrate : {};
        if (appstrate.actedSpaceIds === undefined) {
          result = {
            ...result,
            resultProviderMetadata: { ...meta, appstrate: { ...appstrate, actedSpaceIds } },
          };
        }
      }
    }

    const blocks = contentOf(output);
    const marked = blocks && markNote(blocks);
    if (marked) {
      notes += 1;
      output = Array.isArray(output) ? marked : { ...(output as Json), content: marked };
    }

    return output === part.output ? result : { ...result, output };
  });
  return { parts: next, acted, dropped, notes };
}

/** Narrows the scan to messages that can carry either form; the exact test is `rewriteToolPartStamps`. */
const CANDIDATE = sql`(${chatMessages.content}::text LIKE '%actedSpaceIds%' OR ${chatMessages.content}::text LIKE '%[turn budget] %')`;

type Counts = { scanned: number; parts: number; dropped: number; blocks: number; rows: number };

const PAGE_SIZE = 100;

/**
 * One keyset page after `after`. A writing page (`write` given) selects FOR UPDATE so a concurrent
 * upsert cannot be overwritten by a stale copy; the caller owns the surrounding transaction.
 */
async function scanPage(
  database: Pick<Db, "select">,
  after: number | undefined,
  counts: Counts,
  write?: (seq: number, content: ChatMessageContent) => Promise<void>,
): Promise<{ size: number; last: number | undefined }> {
  const page = database
    .select({ seq: chatMessages.seq, content: chatMessages.content })
    .from(chatMessages)
    .where(and(CANDIDATE, after === undefined ? undefined : gt(chatMessages.seq, after)))
    .orderBy(chatMessages.seq)
    .limit(PAGE_SIZE);
  const rows = await (write ? page.for("update") : page);
  for (const row of rows) {
    counts.scanned++;
    const stored: unknown = row.content.parts;
    const { parts, acted, dropped, notes } = rewriteToolPartStamps(
      Array.isArray(stored) ? stored : [],
    );
    if (acted === 0 && dropped === 0 && notes === 0) continue;
    counts.rows++;
    counts.parts += acted;
    counts.dropped += dropped;
    counts.blocks += notes;
    if (write) await write(row.seq, { ...row.content, parts } as ChatMessageContent);
  }
  return { size: rows.length, last: rows[rows.length - 1]?.seq };
}

const emptyCounts = (): Counts => ({ scanned: 0, parts: 0, dropped: 0, blocks: 0, rows: 0 });

/** Read-only scan of every candidate page; writes nothing. */
async function scanToolPartStamps(database: Pick<Db, "select">): Promise<Counts> {
  const counts = emptyCounts();
  let after: number | undefined;
  for (;;) {
    const { size, last } = await scanPage(database, after, counts);
    if (size < PAGE_SIZE) return counts;
    after = last;
  }
}

export async function pendingToolPartStamps(): Promise<Counts> {
  const { db } = await import("@appstrate/db/client");
  return scanToolPartStamps(db);
}

const describe = (c: Counts) =>
  `messages scanned: ${c.scanned}, parts rewritten (actedSpaceIds): ${c.parts}, dropped (malformed actedSpaceIds): ${c.dropped}, blocks marked (turn budget): ${c.blocks}, rows changed: ${c.rows}`;

export async function runChatToolPartStamps(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<void> {
  const { apply, out } = options;
  const { db } = await import("@appstrate/db/client");
  out(await describeDatabaseTarget());
  if (!apply) {
    out(describe(await pendingToolPartStamps()));
    out("0061: DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  // One transaction per page: the FOR UPDATE locks last for that page only, and a failure mid-run
  // leaves committed pages in the current form (the rewrite is idempotent, so a re-run resumes).
  const done = emptyCounts();
  let after: number | undefined;
  for (;;) {
    const { size, last } = await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      return scanPage(tx, after, done, async (seq, content) => {
        await tx.update(chatMessages).set({ content }).where(eq(chatMessages.seq, seq));
      });
    });
    if (size < PAGE_SIZE) break;
    after = last;
  }
  out(describe(done));
  const left = await scanToolPartStamps(db);
  out(`left: ${left.rows}`);
  if (left.rows !== 0) throw new Error("tool parts in the old form are left after --apply");
  out("0061: APPLIED — committed.");
}

if (import.meta.main) {
  exitUnlessDatabaseNamed();
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0061 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runChatToolPartStamps({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0061: FAILED (pages already committed stay valid; re-run to resume) — ${getErrorMessage(error)}\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
