// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a model refused a file, decided by a replay rather than by the provider's wording.
 *
 * A provider request carrying a file that fails as an invalid request (not for its length) is
 * replayed in the same step with those file parts replaced by a text pointer: the PDFs alone
 * first when images rode too, then both if that replay is refused the same way. Only a replay
 * that succeeds names the cause, and exactly the kinds it withheld are recorded on the turn.
 * When every replay is refused the same way, the turn reports the first error; when one fails
 * otherwise, its own error.
 */

import type { FileInputKind } from "@appstrate/core/chat-turn-metadata";
import { getOverflowPatterns, type ExtensionFactory } from "@appstrate/runner-pi";
import { classifyClientTurnError } from "../turn-error.ts";

/** The part types pi-ai and `native-pdf.ts` write for an image or a PDF, across the chat's APIs. */
const PART_KINDS = new Map<unknown, FileInputKind>([
  ["image", "image"],
  ["input_image", "image"],
  ["image_url", "image"],
  ["document", "pdf"],
  ["input_file", "pdf"],
  ["file", "pdf"],
]);

const WITHHELD = "[file withheld: the model refused it]";

const partKind = (value: object) => PART_KINDS.get((value as { type?: unknown }).type);

/** Walks messages, their content and tool outputs only: a tool call's arguments are the model's. */
function collectKinds(value: unknown, kinds: Set<FileInputKind>): void {
  if (Array.isArray(value)) return value.forEach((item) => collectKinds(item, kinds));
  if (!value || typeof value !== "object") return;
  const kind = partKind(value);
  if (kind) return void kinds.add(kind);
  const { content, output } = value as Record<string, unknown>;
  collectKinds(content, kinds);
  collectKinds(output, kinds);
}

/** The file kinds a provider payload's conversation (not its tool schemas) carries. */
function fileKindsIn(payload: unknown): Set<FileInputKind> {
  const kinds = new Set<FileInputKind>();
  if (payload && typeof payload === "object") {
    const { messages, input } = payload as Record<string, unknown>;
    collectKinds(messages, kinds);
    collectKinds(input, kinds);
  }
  return kinds;
}

function withhold(value: unknown, kinds: ReadonlySet<FileInputKind>, textType: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withhold(item, kinds, textType));
  if (!value || typeof value !== "object") return value;
  const kind = partKind(value);
  if (kind) {
    if (!kinds.has(kind)) return value;
    const { cache_control } = value as { cache_control?: unknown };
    return { type: textType, text: WITHHELD, ...(cache_control ? { cache_control } : {}) };
  }
  const item = value as Record<string, unknown>;
  return {
    ...item,
    ...("content" in item ? { content: withhold(item.content, kinds, textType) } : {}),
    ...("output" in item ? { output: withhold(item.output, kinds, textType) } : {}),
  };
}

/** The payload with every file part of these kinds replaced by a text pointer. */
function withholdFiles(
  payload: unknown,
  kinds: ReadonlySet<FileInputKind>,
  api: string | null | undefined,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const textType =
    api === "openai-responses" || api === "openai-codex-responses" ? "input_text" : "text";
  const { messages, input } = payload as Record<string, unknown>;
  return {
    ...payload,
    ...(messages === undefined ? {} : { messages: withhold(messages, kinds, textType) }),
    ...(input === undefined ? {} : { input: withhold(input, kinds, textType) }),
  };
}

const OVERFLOW_PATTERNS = getOverflowPatterns();

/**
 * What a refused file fails as: an invalid request (any 4xx but auth, quota and throttling) that
 * pi-ai's overflow patterns do not read as too long — the llm-proxy's 413 body limit among them.
 */
function mayBeFileRefusal(errorText: string): boolean {
  const text = errorText.trim();
  return (
    classifyClientTurnError(text).category === "invalid_request" &&
    !OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
  );
}

interface FileRefusal {
  /** Must be the last `before_provider_request` handler: it reads and edits the payload as sent. */
  extension: ExtensionFactory;
  /** The kinds withheld by the replay that succeeded this turn. */
  refusedKinds(): FileInputKind[];
  /** The first failure's text when every replay was refused the same way: the turn's error. */
  originalError(): string | undefined;
}

interface Replay {
  /** Every kind withheld so far by this replay chain. */
  kinds: FileInputKind[];
  /** Kinds that rode the failed request and are still sent, for the one escalation. */
  remaining: FileInputKind[];
  /** The failed request's error, before any replay. */
  error: string;
  /** The latest replay's own error, retries included. */
  lastError?: string;
}

interface AssistantView {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

/** `onReplay` runs when a replay is requested: the failed attempt is no longer the turn's error. */
export function createFileRefusal(
  api: string | null | undefined,
  onReplay: () => void = () => {},
): FileRefusal {
  const withheld = new Set<FileInputKind>();
  const refused = new Set<FileInputKind>();
  let sent: FileInputKind[] = [];
  let suspect: { kinds: FileInputKind[]; error: string } | undefined;
  let replay: Replay | undefined;
  let original: string | undefined;

  return {
    refusedKinds: () => [...refused],
    originalError: () => original,
    extension(pi) {
      pi.on("before_provider_request", ({ payload }) => {
        const sending = withheld.size ? withholdFiles(payload, withheld, api) : payload;
        sent = [...fileKindsIn(sending)];
        return withheld.size ? sending : undefined;
      });
      // Errors are judged where Pi settles a run, after its own retries.
      pi.on("turn_end", ({ message }) => {
        const m = message as AssistantView;
        if (m.role !== "assistant") return;
        const error = typeof m.errorMessage === "string" ? m.errorMessage : "";
        if (m.stopReason === "aborted") {
          suspect = replay = undefined;
        } else if (m.stopReason !== "error") {
          for (const kind of replay?.kinds ?? []) refused.add(kind);
          suspect = replay = original = undefined;
        } else if (replay) {
          replay.lastError = error;
        } else {
          suspect = sent.length && mayBeFileRefusal(error) ? { kinds: sent, error } : undefined;
        }
      });
      pi.on("agent_before_settle", ({ outcome, context }) => {
        if (outcome !== "error" || (!suspect && !replay)) return;
        const failed = context.contextEntries.findLast(
          ({ sourceEntry }) =>
            sourceEntry.type === "message" && sourceEntry.message.role === "assistant",
        )?.sourceEntry;
        if (failed?.type !== "message" || failed.message.role !== "assistant") return;
        if (failed.message.stopReason !== "error") return;
        const refusedAgain = replay !== undefined && mayBeFileRefusal(replay.lastError ?? "");
        if (replay && !(refusedAgain && replay.remaining.length)) {
          original = refusedAgain ? replay.error : undefined;
          replay = undefined;
          return;
        }
        if (replay) {
          replay = { ...replay, kinds: [...replay.kinds, ...replay.remaining], remaining: [] };
        } else {
          // A new PDF beside an image already accepted earlier must not cut the image.
          const both = suspect!.kinds.includes("pdf") && suspect!.kinds.length > 1;
          const kinds: FileInputKind[] = both ? ["pdf"] : suspect!.kinds;
          replay = {
            kinds,
            remaining: suspect!.kinds.filter((kind) => !kinds.includes(kind)),
            error: suspect!.error,
          };
          suspect = undefined;
        }
        for (const kind of replay.kinds) withheld.add(kind);
        onReplay();
        // Omitted like Pi's own retries omit a failed attempt; it ran no tool.
        return {
          entries: [{ type: "context_edit", targetId: failed.id, replacement: null }],
          continue: true,
        };
      });
    },
  };
}
