// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a model refused a file, decided by a replay rather than by the provider's wording.
 *
 * A provider request carrying a file that fails as an invalid request (not for its length) is
 * replayed once, in the same step, with those file parts replaced by a text pointer. Only when
 * that replay succeeds was the file the cause: the turn carries on without it and the kinds are
 * recorded on the turn. When the replay fails too, the turn reports the first error.
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
export function fileKindsIn(payload: unknown): Set<FileInputKind> {
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
export function withholdFiles(
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
export function mayBeFileRefusal(errorText: string): boolean {
  const text = errorText.trim();
  return (
    classifyClientTurnError(text).category === "invalid_request" &&
    !OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
  );
}

interface FileRefusal {
  /** Must be the last `before_provider_request` handler: it reads and edits the payload as sent. */
  extension: ExtensionFactory;
  /** The kinds whose replay without them succeeded this turn. */
  refusedKinds(): FileInputKind[];
  /** The first failure's text when its replay failed too: the error the turn reports. */
  originalError(): string | undefined;
}

interface Suspect {
  kinds: FileInputKind[];
  error: string;
}

interface AssistantView {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

export function createFileRefusal(api: string | null | undefined): FileRefusal {
  const withheld = new Set<FileInputKind>();
  const refused = new Set<FileInputKind>();
  let sent: FileInputKind[] = [];
  let suspect: Suspect | undefined;
  let replay: Suspect | undefined;
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
      pi.on("turn_end", ({ message }) => {
        const m = message as AssistantView;
        if (m.role !== "assistant") return;
        if (m.stopReason === "aborted") {
          suspect = replay = undefined;
          return;
        }
        if (m.stopReason !== "error") {
          for (const kind of replay?.kinds ?? []) refused.add(kind);
          suspect = replay = original = undefined;
          return;
        }
        if (replay) {
          original = replay.error;
          suspect = replay = undefined;
          return;
        }
        const error = typeof m.errorMessage === "string" ? m.errorMessage : "";
        suspect = sent.length && mayBeFileRefusal(error) ? { kinds: sent, error } : undefined;
      });
      // A failed step ends the run, so the replay is requested where Pi settles it.
      pi.on("agent_before_settle", ({ outcome, context }) => {
        if (!suspect || outcome !== "error") return;
        const failed = context.contextEntries.findLast(
          ({ sourceEntry }) =>
            sourceEntry.type === "message" && sourceEntry.message.role === "assistant",
        )?.sourceEntry;
        if (failed?.type !== "message" || failed.message.role !== "assistant") return;
        if (failed.message.stopReason !== "error") return;
        replay = suspect;
        suspect = undefined;
        for (const kind of replay.kinds) withheld.add(kind);
        // Omitted like Pi's own retries omit a failed attempt; it ran no tool.
        return {
          entries: [{ type: "context_edit", targetId: failed.id, replacement: null }],
          continue: true,
        };
      });
    },
  };
}
