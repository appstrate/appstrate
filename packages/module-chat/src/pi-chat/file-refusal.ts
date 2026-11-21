// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a model refused a file, decided by a replay, not by the provider's wording. The rule
 * and its replay order: `docs/architecture/FILES.md`.
 */

import {
  isContextOverflow,
  isRetryableAssistantError,
  type ExtensionFactory,
  type Message,
} from "@appstrate/runner-pi";
import {
  classifyModelError,
  describeModelFailure,
  type ModelErrorCategory,
} from "@appstrate/core/model-error";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { wireParts, type WireParts } from "../file-input.ts";

type FileKind = "image" | "pdf";

/** Names the kind, so the model does not doubt the files of the other kind it did receive. */
const WITHHELD: Record<FileKind, string> = {
  image: "[image withheld: the provider rejected the request carrying it]",
  pdf: "[PDF withheld: the provider rejected the request carrying it]",
};

function partKind(value: object, parts: WireParts): FileKind | undefined {
  const { type } = value as { type?: unknown };
  if (type === parts.image) return "image";
  return parts.pdf !== undefined && type === parts.pdf ? "pdf" : undefined;
}

/** Walks messages, their content and tool outputs only: a tool call's arguments are the model's. */
function collectKinds(value: unknown, parts: WireParts, kinds: Set<FileKind>): void {
  if (Array.isArray(value)) return value.forEach((item) => collectKinds(item, parts, kinds));
  if (!value || typeof value !== "object") return;
  const kind = partKind(value, parts);
  if (kind) return void kinds.add(kind);
  const { content, output } = value as Record<string, unknown>;
  collectKinds(content, parts, kinds);
  collectKinds(output, parts, kinds);
}

/** The file kinds a provider payload's conversation (not its tool schemas) carries. */
function fileKindsIn(payload: unknown, parts: WireParts): Set<FileKind> {
  const kinds = new Set<FileKind>();
  if (payload && typeof payload === "object") {
    const { messages, input } = payload as Record<string, unknown>;
    collectKinds(messages, parts, kinds);
    collectKinds(input, parts, kinds);
  }
  return kinds;
}

function withhold(value: unknown, kinds: ReadonlySet<FileKind>, parts: WireParts): unknown {
  if (Array.isArray(value)) return value.map((item) => withhold(item, kinds, parts));
  if (!value || typeof value !== "object") return value;
  const kind = partKind(value, parts);
  if (kind) {
    if (!kinds.has(kind)) return value;
    const { cache_control } = value as { cache_control?: unknown };
    return { type: parts.text, text: WITHHELD[kind], ...(cache_control ? { cache_control } : {}) };
  }
  const item = value as Record<string, unknown>;
  return {
    ...item,
    ...("content" in item ? { content: withhold(item.content, kinds, parts) } : {}),
    ...("output" in item ? { output: withhold(item.output, kinds, parts) } : {}),
  };
}

/** The payload with every file part of these kinds replaced by a text pointer. */
function withholdFiles(payload: unknown, kinds: ReadonlySet<FileKind>, parts: WireParts): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const { messages, input } = payload as Record<string, unknown>;
  return {
    ...payload,
    ...(messages === undefined ? {} : { messages: withhold(messages, kinds, parts) }),
    ...(input === undefined ? {} : { input: withhold(input, kinds, parts) }),
  };
}

type AssistantMessage = Extract<Message, { role: "assistant" }>;

/** A request timeout and a conflict are 4xx a retry can clear: not a verdict on the file. */
const TRANSIENT_REQUEST_STATUSES = new Set([408, 409]);

/** Responses error frames can carry a code without an HTTP status. */
const NON_FILE_ERROR_CODES = new Set([
  "authentication_error",
  "invalid_api_key",
  "permission_denied",
  "insufficient_quota",
  "usage_limit_reached",
  "usage_not_included",
  "rate_limit_exceeded",
  "server_error",
  "context_length_exceeded",
]);

/**
 * The category a failed call is a refusal candidate under, or undefined when it is not one.
 * An invalid request, or a failure with no recognised cause: Codex reports a refused file with
 * no status in its text, so the response's status, when observed, outranks the text. Never auth,
 * quota, throttling, a 5xx, Pi's own transient or overflow verdicts — the llm-proxy's 413 body
 * limit among them.
 */
function refusalCategory(
  message: AssistantMessage,
  observed?: number,
): ModelErrorCategory | undefined {
  const text = (message.errorMessage ?? "").trim();
  const status = observed ?? describeModelFailure(text).status;
  if (status !== undefined && (status >= 500 || TRANSIENT_REQUEST_STATUSES.has(status)))
    return undefined;
  const { category } = classifyModelError({
    message: text,
    ...(status !== undefined ? { status } : {}),
  });
  if (category !== "invalid_request" && category !== "unknown") return undefined;
  // A known 4xx is authoritative over its prose; Pi's transient patterns judge the rest.
  if (category === "unknown" && isRetryableAssistantError(message)) return undefined;
  return isContextOverflow(message) ? undefined : category;
}

/** The client was already streamed part of this attempt's answer: a replay would add a second. */
function streamedContent(message: AssistantMessage): boolean {
  return message.content.some(
    (part) =>
      part.type === "toolCall" ||
      (part.type === "text" && part.text !== "") ||
      (part.type === "thinking" && part.thinking !== ""),
  );
}

interface FileRefusal {
  /** Must be the last `before_provider_request` handler: it reads and edits the payload as sent. */
  extension: ExtensionFactory;
  /**
   * The kinds withheld from a replay that then succeeded, for the server log. Not the refused
   * ones: after the escalation, either kind could have been the cause.
   */
  withheldKinds(): FileKind[];
  /** The first failure's text when every replay was refused the same way: the turn's error. */
  originalError(): string | undefined;
}

interface Suspect {
  kinds: FileKind[];
  error: string;
  category: ModelErrorCategory;
}

interface Replay {
  /** Every kind withheld so far by this replay chain. */
  kinds: FileKind[];
  /** Kinds that rode the failed request and are still sent, for the one escalation. */
  remaining: FileKind[];
  /** The failed request's error, before any replay. */
  error: string;
  /** The failed request's refusal category: a replay failing under it is refused the same way. */
  category: ModelErrorCategory;
  /** The latest replay's own failure, retries included. */
  lastCategory?: ModelErrorCategory;
}

/** `onReplay` runs when a replay is requested: the failed attempt is no longer the turn's error. */
export function createFileRefusal(
  api: string | null | undefined,
  onReplay: () => void,
): FileRefusal {
  // An API without known part types carries no file the refusal can see: it never replays.
  const parts = wireParts(api);
  const withheld = new Set<FileKind>();
  const answeredWithout = new Set<FileKind>();
  let sent: FileKind[] = [];
  let responseStatus: number | undefined;
  let nonFileStreamError = false;
  // Pi can retry a failed attempt before settling the step. Its earlier output is still visible.
  let stepStreamed = false;
  let suspect: Suspect | undefined;
  let replay: Replay | undefined;
  let original: string | undefined;

  return {
    withheldKinds: () => [...answeredWithout],
    originalError: () => original,
    extension(pi) {
      pi.on("before_provider_request", ({ payload }) => {
        if (!parts) return;
        const sending = withheld.size ? withholdFiles(payload, withheld, parts) : payload;
        sent = [...fileKindsIn(sending, parts)];
        responseStatus = undefined;
        nonFileStreamError = false;
        return withheld.size ? sending : undefined;
      });
      // Only some adapters report a refused response here (Codex does); a 2xx says nothing of a
      // failure later in its stream.
      pi.on("after_provider_response", ({ status }) => {
        responseStatus = status >= 400 ? status : undefined;
      });
      if (api === "openai-codex-responses" || api === "openai-responses") {
        pi.on("provider_stream_event", ({ data }) => {
          const frame = asRecordOrNull(data);
          if (frame?.type !== "error" && frame?.type !== "response.failed") return;
          // WebSocket errors and failures inside HTTP 200 SSE streams carry their own verdict.
          const error = asRecordOrNull(
            frame.type === "error" ? frame.error : asRecordOrNull(frame.response)?.error,
          );
          if (typeof frame.status === "number" && frame.status >= 400 && frame.status < 600) {
            responseStatus = frame.status;
          }
          nonFileStreamError = [frame.code, error?.code, error?.type].some(
            (code) => typeof code === "string" && NON_FILE_ERROR_CODES.has(code),
          );
        });
      }
      // Errors are judged where Pi settles a run, after its own retries.
      pi.on("turn_end", ({ message }) => {
        if (message.role !== "assistant") return;
        const m = message as AssistantMessage;
        if (m.stopReason !== "error") {
          if (m.stopReason !== "aborted") {
            for (const kind of replay?.kinds ?? []) answeredWithout.add(kind);
          }
          stepStreamed = false;
          suspect = replay = original = undefined;
          return;
        }
        stepStreamed ||= streamedContent(m);
        const category =
          stepStreamed || nonFileStreamError ? undefined : refusalCategory(m, responseStatus);
        if (replay) {
          replay.lastCategory = category;
        } else {
          suspect =
            sent.length && category
              ? { kinds: sent, error: m.errorMessage ?? "", category }
              : undefined;
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
        const refusedAgain = replay !== undefined && replay.lastCategory === replay.category;
        if (replay && !(refusedAgain && replay.remaining.length)) {
          original = refusedAgain ? replay.error : undefined;
          replay = undefined;
          return;
        }
        if (replay) {
          replay = { ...replay, kinds: [...replay.kinds, ...replay.remaining], remaining: [] };
        } else {
          // A new PDF beside an image already read must not cut the image: PDFs go first.
          const both = suspect!.kinds.includes("pdf") && suspect!.kinds.length > 1;
          const kinds: FileKind[] = both ? ["pdf"] : suspect!.kinds;
          replay = {
            kinds,
            remaining: suspect!.kinds.filter((kind) => !kinds.includes(kind)),
            error: suspect!.error,
            category: suspect!.category,
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
