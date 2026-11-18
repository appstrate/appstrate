#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0055 — chat file reads persisted before #2280, rewritten as the receipts the chat now persists:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0055-chat-file-read-receipts.ts [--apply]
 *
 * A `read_file` / `read_resource` call on an `appfile://` URI used to persist what the model read:
 * the file's text verbatim, or its bytes as a base64 `blob` inside a JSON resource. Every later
 * turn re-sent that history to the model. The chat now persists a receipt instead (one JSON text
 * block: `{ uri, mimeType, size, note }`, no content). This script removes the old contents from
 * stored history. Model replay independently projects a previous file read from its URI alone.
 *
 * A block is kept when it already is a receipt or platform metadata: a JSON object carrying a
 * `note` and neither `text` nor `blob`. Any other content of such a call is replaced by one receipt
 * naming the URI (and the MIME type and size when the old resource said them). A `skill://` read is
 * not touched: its instructions are meant to stay in the history.
 *
 * Run in the release window with the app stopped: until it has run, loading an old thread can
 * return the original file contents to the browser. A dry run counts affected messages and calls.
 * With `--apply`, rewrites them in one transaction and exits 1 unless none is left after.
 * Idempotent: a second run finds nothing. Counts UNMEASURED: rehearse on a restored dump and
 * record them in the README's Log. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with neither
 * (`lib/database-target.ts`).
 */

import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { chatMessages, type ChatMessageContent } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";

const FILE_READ_TOOLS = new Set(["read_file", "read_resource"]);
const NOTE = "File content omitted: read in an earlier version of the chat.";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toolNameOf(part: Json): string | null {
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : null;
  return typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : null;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A receipt, or the platform's metadata of a file: says what was read, carries none of it. */
function isReceipt(block: unknown): boolean {
  if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return false;
  const parsed = parse(block.text);
  return (
    isObject(parsed) &&
    typeof parsed.note === "string" &&
    !("text" in parsed) &&
    !("blob" in parsed)
  );
}

/** What the old content said of the file (an embedded resource, bare or wrapped), for the receipt. */
function describedResource(content: readonly unknown[]): { mimeType?: string; size?: number } {
  for (const block of content) {
    if (!isObject(block) || typeof block.text !== "string") continue;
    const parsed = parse(block.text);
    const resource = isObject(parsed) && isObject(parsed.resource) ? parsed.resource : parsed;
    if (!isObject(resource)) continue;
    const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
    const size =
      typeof resource.blob === "string"
        ? Buffer.byteLength(resource.blob, "base64")
        : typeof resource.text === "string"
          ? Buffer.byteLength(resource.text)
          : undefined;
    if (mimeType || size !== undefined) return { mimeType, size };
  }
  return {};
}

/**
 * The parts of one message with every pre-receipt file read rewritten, and how many calls changed.
 * Pure, so the shape it writes is tested without a database.
 */
export function rewriteFileReads(parts: readonly unknown[]): {
  parts: unknown[];
  rewritten: number;
} {
  let rewritten = 0;
  const next = parts.map((part) => {
    if (!isObject(part)) return part;
    const name = toolNameOf(part);
    const uri = isObject(part.input) ? part.input.uri : undefined;
    if (!name || !FILE_READ_TOOLS.has(name) || typeof uri !== "string") return part;
    if (!uri.startsWith("appfile://") || !isObject(part.output)) return part;
    const content = Array.isArray(part.output.content) ? part.output.content : [];
    if (content.length > 0 && content.every(isReceipt)) return part;
    rewritten += 1;
    const described = describedResource(content);
    const receipt = { uri, ...described, note: NOTE };
    return {
      ...part,
      output: { ...part.output, content: [{ type: "text", text: JSON.stringify(receipt) }] },
    };
  });
  return { parts: next, rewritten };
}

/** Narrows the scan to messages that can hold a file read; the exact test is `rewriteFileReads`. */
const CANDIDATE = sql`${chatMessages.content}::text LIKE '%appfile://%' AND (${chatMessages.content}::text LIKE '%read_file%' OR ${chatMessages.content}::text LIKE '%read_resource%')`;

export async function runChatFileReadReceipts(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<void> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const pending = async () => {
    const rows = await db
      .select({ seq: chatMessages.seq, content: chatMessages.content })
      .from(chatMessages)
      .where(CANDIDATE)
      .orderBy(chatMessages.seq);
    return rows.flatMap((row) => {
      const { parts, rewritten } = rewriteFileReads(row.content.parts ?? []);
      return rewritten > 0 ? [{ seq: row.seq, content: { ...row.content, parts }, rewritten }] : [];
    });
  };

  const rows = await pending();
  const calls = rows.reduce((sum, row) => sum + row.rewritten, 0);
  out(`messages to rewrite: ${rows.length}, file reads: ${calls}`);
  if (!apply) {
    out("0055: DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute("SET LOCAL lock_timeout = '5s'");
    await tx.execute("SET LOCAL statement_timeout = '300s'");
    for (const row of rows) {
      await tx
        .update(chatMessages)
        .set({ content: row.content as ChatMessageContent })
        .where(eq(chatMessages.seq, row.seq));
    }
  });
  out(`rewritten: ${rows.length}`);
  const left = (await pending()).length;
  out(`left: ${left}`);
  if (left !== 0) throw new Error("file reads in the old form are left after --apply");
  out("0055: APPLIED — committed.");
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
    out(`0055 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runChatFileReadReceipts({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0055: FAILED — ${getErrorMessage(error)}. The update is one transaction; a re-run with --apply finishes what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
