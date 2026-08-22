// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciliation of a run that OUTLIVES the chat turn that launched it (C3/D5).
 *
 * The audited session produced a 22 846-byte `report.html` two minutes AFTER its
 * turn was killed by the turn deadline. The file exists, attached to the
 * run, and no message in the session ever mentioned it — 4.68 USD of work
 * delivered to nobody.
 *
 * The fix is a MESSAGE, not a change of ownership: `files.run_id` and
 * `files.chat_session_id` are an exclusive container pair
 * (`chk_files_single_container`), so there is no re-parenting a run's
 * deliverable into the conversation. This module therefore does two things:
 *
 *  1. {@link stampChatSessionOnRun} — at launch, record WHICH chat session
 *     started the run, on the first-class `runs.chat_session_id` relationship.
 *     Written by the chat itself rather than accepted
 *     from a request header, so the link can only ever exist for a run the chat
 *     genuinely launched — a header would have made "write a message into a chat
 *     session" reachable from the public run routes.
 *  2. {@link reconcileChatRun} — on the terminal `onRunStatusChange` event, if
 *     that session has no live turn, post a notice naming the run and its
 *     published files.
 *
 * Liveness is `chat_sessions.active_stream_id IS NULL`. That column is the
 * platform's existing single source of truth for "a turn is generating" (the
 * session DTO's `generating` flag reads exactly it), set when a turn starts and
 * cleared when it finalizes, with the established convention that a stale id
 * whose producer is gone counts as no stream. It is also the SAFE condition
 * rather than merely the convenient one: chat persistence is single-writer, and
 * a notice inserted while a turn is mid-flight would chain onto the in-progress
 * user message and race the assistant message that turn is about to persist.
 *
 * Consequences, accepted deliberately:
 *  - a run still being awaited by its own live turn is skipped — that turn's
 *    `run_and_wait` receives the result and the model reports it (the turn
 *    budget guarantees the wait cannot outlive the turn), so a notice would
 *    duplicate what the user is already reading;
 *  - if a NEWER turn happens to be generating at the instant the orphan
 *    finalizes, the notice is skipped and not retried. The deliverable is still
 *    reachable (run page, files gallery). Retrying would mean a queue, a
 *    worker or a table — all three out of proportion for this.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessions, files, runs } from "@appstrate/db/schema";
import { fileUri } from "@appstrate/core/file-uri";
import { persistNotice } from "./persistence.ts";
import { buildRunPageHref } from "./ui/run-events.ts";
import { logger } from "./logger.ts";

/** One file named in the notice. */
interface NoticedFile {
  id: string;
  name: string;
  size: number;
}

/**
 * Deterministic `chat_messages.message_id` for a run's reconciliation notice —
 * derived from the run id alone, so the `(session_id, message_id)` uniqueness
 * makes a replayed event (at-least-once broadcast, a retried finalize on another
 * replica) a no-op instead of a second copy.
 */
export function runNoticeMessageId(runId: string): string {
  return `run_notice_${runId}`;
}

/** Display ceiling for a file name inside the notice. */
const NOTICE_NAME_MAX_CHARS = 80;

/**
 * Render an agent-chosen file name safely inside the notice.
 *
 * The name is UNTRUSTED: a sub-agent processing injected third-party content
 * picks it, and `sanitizeFilename` only strips path separators and control
 * characters (truncating at 255), so arbitrary prose survives. This notice is
 * persisted with `role: "assistant"` and replayed to the model on the next
 * turn, so an unquoted name would let a file name become text the orchestrator
 * reads back as its OWN prior statement — prompt injection with the assistant's
 * authority. File names already reach the model through `run_and_wait`'s
 * `files` list, but that is a tool result, not the assistant channel.
 *
 * Two defences: a hard length cap well under `sanitizeFilename`'s 255, and a
 * code span. Backticks in the name are stripped rather than escaped — a name is
 * a label here, not markup, and stripping cannot be undone by nesting.
 */
function renderNoticeName(name: string): string {
  const flattened = name.replace(/[`\r\n]+/g, " ").trim();
  const clipped =
    flattened.length > NOTICE_NAME_MAX_CHARS
      ? `${flattened.slice(0, NOTICE_NAME_MAX_CHARS - 1)}…`
      : flattened;
  return `\`${clipped || "file"}\``;
}

/**
 * The user-facing notice (French — this product's UI language, matching
 * `turnDeadlineNoticeText`). States that the run finished after its turn, names
 * it, links its run page when there is one, and lists what it produced.
 */
export function runNoticeText(input: {
  runId: string;
  packageId: string | null;
  status: string;
  files: readonly NoticedFile[];
}): string {
  const href = buildRunPageHref(input.packageId ?? undefined, input.runId);
  const lines = input.files.map(
    (file) => `- ${renderNoticeName(file.name)} (${file.size} o) — \`${fileUri(file.id)}\``,
  );
  const label = href ? `[\`${input.runId}\`](${href})` : `\`${input.runId}\``;
  return (
    `📦 Le run ${label} s'est terminé (${input.status}) après la fin du tour qui l'avait lancé. ` +
    `Voici ce qu'il a produit :\n\n${lines.join("\n")}\n\n` +
    `Ces fichiers sont conservés. Envoyez-moi un message si vous voulez que je les reprenne.`
  );
}

/**
 * Record the launching chat session on a just-created run. The dedicated
 * relationship column keeps conversation context queryable and cannot clobber
 * unrelated run metadata. The write is scoped by `org_id` as well as `id`.
 *
 * Best-effort: a failure here costs the reconciliation notice for this one run,
 * and must never fail the `run_and_wait` tool call that just succeeded.
 */
export async function stampChatSessionOnRun(
  runId: string,
  orgId: string,
  chatSessionId: string,
): Promise<void> {
  try {
    await db
      .update(runs)
      .set({ chatSessionId })
      .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)));
  } catch (err) {
    logger.warn("chat: failed to link run to its chat session", {
      runId,
      chatSessionId,
      err: String(err),
    });
  }
}

/**
 * Post the reconciliation notice for a terminal run, when it is owed. Returns
 * true only when a notice was actually written — every other outcome is a
 * deliberate skip:
 *
 *  - the run was not launched from a chat session;
 *  - its session is gone;
 *  - a turn is generating on that session (see the liveness rationale above);
 *  - the run published no file, so there is nothing to announce;
 *  - the notice for this run is already in the transcript.
 */
export async function reconcileChatRun(input: { runId: string; orgId: string }): Promise<boolean> {
  const [run] = await db
    .select({
      chatSessionId: runs.chatSessionId,
      packageId: runs.packageId,
      status: runs.status,
    })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.orgId, input.orgId)))
    .limit(1);
  const chatSessionId = run?.chatSessionId;
  if (!run || !chatSessionId) return false;

  const [session] = await db
    .select({ activeStreamId: chatSessions.activeStreamId })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, chatSessionId), eq(chatSessions.orgId, input.orgId)))
    .limit(1);
  if (!session) return false;
  // A live turn owns the conversation: it is awaiting this very run (or writing
  // its own reply) and is the single writer until it finalizes.
  if (session.activeStreamId !== null) return false;

  const published = await db
    .select({ id: files.id, name: files.name, size: files.size })
    .from(files)
    .where(
      and(
        eq(files.runId, input.runId),
        eq(files.orgId, input.orgId),
        eq(files.purpose, "agent_output"),
      ),
    )
    .orderBy(asc(files.createdAt));
  if (published.length === 0) return false;

  const posted = await persistNotice(
    chatSessionId,
    runNoticeMessageId(input.runId),
    runNoticeText({
      runId: input.runId,
      packageId: run.packageId,
      status: run.status,
      files: published,
    }),
  );
  if (posted) {
    logger.info("chat: announced an orphaned run's files in its session", {
      runId: input.runId,
      chatSessionId,
      files: published.length,
    });
  }
  return posted;
}
