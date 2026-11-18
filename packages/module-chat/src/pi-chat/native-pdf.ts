// SPDX-License-Identifier: Apache-2.0

import { sanitizeFilename } from "@appstrate/core/naming";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import type { ExtensionFactory } from "@appstrate/runner-pi";
import {
  FILE_INPUT_REFUSED_NOTE,
  isPdfWireApi,
  type FileDelivery,
  type PdfWireApi,
} from "../file-input.ts";

/** A one-turn reference to a PDF, swapped for the file itself at serialization. */
const REFERENCE = /\[pdf:[0-9a-f-]{36}\]/g;

const PDF_INPUT_UNSUPPORTED =
  "This model's chat adapter does not accept PDF input. Use an inline run to inspect the file.";

interface PdfFile {
  name: string;
  data: string;
}

interface PdfReceipt {
  note: string;
  /** A one-turn reference placed only in the in-memory Pi message and removed on serialization. */
  reference?: string;
}

export interface TurnPdfInput {
  /** Why this turn sends no PDF, the note each one gets; `undefined` when PDFs are sent. */
  unsupported?: string;
  /** Without a tool call id, the PDF belongs to the current user message. */
  add(file: PdfFile, toolCallId?: string): PdfReceipt;
  extension: ExtensionFactory;
}

/** The model fields the wire format depends on. */
interface PdfWireModel {
  api: string | null | undefined;
  compat?: unknown;
}

interface StoredFile extends PdfFile {
  source?: string;
  receipt: PdfReceipt & { reference: string };
}

/** pi-ai builds request payloads as plain JSON; each encoder reads only what its converter writes. */
type Block = { type?: unknown; text?: unknown; cache_control?: unknown; [key: string]: unknown };
type Message = Record<string, unknown>;

/** Removes the references from an item's text blocks; `undefined` when the item carries none. */
type Strip = (
  blocks: Block[],
  source: string | undefined,
  textType: string,
) => { blocks: Block[]; files: StoredFile[] } | undefined;

interface PdfEncoder {
  /** The tool call id as the API writes it on the wire. */
  source(toolCallId: string): string;
  encode(payload: Message, strip: Strip, compat: unknown): Message | undefined;
}

const toBlocks = (content: unknown, textType: string): Block[] | undefined =>
  typeof content === "string"
    ? [{ type: textType, text: content }]
    : Array.isArray(content)
      ? content
      : undefined;

const dataUrl = (file: StoredFile) => `data:application/pdf;base64,${file.data}`;

/** pi-ai marks the last cacheable block of the last message; a rewrite keeps the mark on the new last one. */
function keepCacheMark(before: Block[], after: Block[], cacheable: (block: Block) => boolean) {
  const mark = before.find((block) => block?.cache_control)?.cache_control;
  if (!mark) return after;
  const blocks: Block[] = after.map(({ cache_control: _, ...block }) => block);
  const last = blocks.findLastIndex(cacheable);
  if (last >= 0) blocks[last] = { ...blocks[last], cache_control: mark };
  return blocks;
}

/** Items of a Responses request that carry a tool's output: plain and grammar (custom) tools. */
const TOOL_OUTPUT_TYPES = new Set<unknown>(["function_call_output", "custom_tool_call_output"]);

const RESPONSES: PdfEncoder = {
  // Pi pairs Responses calls as "call_id|item_id"; only call_id goes on the wire.
  source: (id) => id.split("|", 1)[0]!,
  encode(payload, strip) {
    if (!Array.isArray(payload.input)) return;
    const input = (payload.input as Message[]).map((item) => {
      const user = item?.role === "user";
      if (!user && !TOOL_OUTPUT_TYPES.has(item?.type)) return item;
      const key = user ? "content" : "output";
      const blocks = toBlocks(item[key], "input_text");
      const taken = blocks && strip(blocks, user ? undefined : String(item.call_id), "input_text");
      if (!taken) return item;
      const files = taken.files.map((file) => ({
        type: "input_file",
        filename: file.name,
        file_data: dataUrl(file),
      }));
      return { ...item, [key]: [...taken.blocks, ...files] };
    });
    return { ...payload, input };
  },
};

const anthropicDocument = (file: StoredFile) => ({
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: file.data },
});

const ANTHROPIC: PdfEncoder = {
  // pi-ai normalizes only another model's tool call ids; this turn's reach the wire unchanged.
  source: (id) => id,
  encode(payload, strip) {
    if (!Array.isArray(payload.messages)) return;
    const messages = (payload.messages as Message[]).map((message) => {
      const blocks = message?.role === "user" && toBlocks(message.content, "text");
      if (!blocks) return message;
      // pi-ai merges a step's tool results into one user message of tool_result blocks.
      const withResults = blocks.map((block) => {
        const inner = block?.type === "tool_result" && toBlocks(block.content, "text");
        const taken = inner && strip(inner, String(block.tool_use_id), "text");
        if (!taken) return block;
        // Anthropic rejects anything but text in an error result: its PDF is not sent.
        const content = [
          ...taken.blocks,
          ...(block.is_error ? [] : taken.files.map(anthropicDocument)),
        ];
        return { ...block, content: content.length ? content : "" };
      });
      const taken = strip(withResults, undefined, "text");
      const next = taken ? [...taken.blocks, ...taken.files.map(anthropicDocument)] : withResults;
      if (next.length === blocks.length && next.every((block, i) => block === blocks[i])) {
        return message;
      }
      return { ...message, content: keepCacheMark(blocks, next, () => true) };
    });
    return { ...payload, messages };
  },
};

const completionsFile = (file: StoredFile) => ({
  type: "file",
  file: { filename: file.name, file_data: dataUrl(file) },
});
const isText = (block: Block) => block?.type === "text";
/** pi-ai's user message for tool images, and the assistant turn it puts before it when required. */
const TOOL_IMAGES_CAPTION = "Attached image(s) from tool result:";
const BRIDGE_TEXT = "I have processed the tool results.";

const requiresAssistantAfterToolResult = (compat: unknown) =>
  typeof compat === "object" &&
  compat !== null &&
  "requiresAssistantAfterToolResult" in compat &&
  compat.requiresAssistantAfterToolResult === true;

const COMPLETIONS: PdfEncoder = {
  // pi-ai normalizes only another model's tool call ids; this turn's reach the wire unchanged.
  source: (id) => id,
  encode(payload, strip, compat) {
    if (!Array.isArray(payload.messages)) return;
    const input = payload.messages as Message[];
    const bridged = requiresAssistantAfterToolResult(compat);
    const followUps = new Map<number, Message>();
    const messages: Message[] = [];
    let files: Block[] = [];
    input.forEach((message, i) => {
      const followUp = followUps.get(i);
      if (followUp) return void messages.push(followUp);
      const blocks =
        (message?.role === "user" || message?.role === "tool") && toBlocks(message.content, "text");
      if (!blocks) return void messages.push(message);
      if (message.role === "user") {
        const taken = strip(blocks, undefined, "text");
        const content = taken && [...taken.blocks, ...taken.files.map(completionsFile)];
        return void messages.push(
          content ? { ...message, content: keepCacheMark(blocks, content, isText) } : message,
        );
      }
      const taken = strip(blocks, String(message.tool_call_id), "text");
      if (taken) {
        files.push(...taken.files.map(completionsFile));
        const text =
          taken.blocks.map((block) => block.text).join("\n") ||
          (taken.files.length ? "(see attached PDF)" : "(no tool output)");
        const content =
          typeof message.content === "string"
            ? text
            : keepCacheMark(blocks, [{ type: "text", text }], isText);
        messages.push({ ...message, content });
      } else messages.push(message);
      if (!files.length || input[i + 1]?.role === "tool") return;
      // Tool messages are text only: like pi-ai's tool images, the PDFs follow the run in a user message.
      const at = i + (bridged ? 2 : 1);
      const next = input[at];
      if (
        next?.role === "user" &&
        Array.isArray(next.content) &&
        next.content[0]?.text === TOOL_IMAGES_CAPTION
      ) {
        followUps.set(at, { ...next, content: [...next.content, ...files] });
      } else {
        if (bridged) messages.push({ role: "assistant", content: BRIDGE_TEXT });
        messages.push({
          role: "user",
          content: [{ type: "text", text: "Attached PDF(s) from tool result:" }, ...files],
        });
      }
      files = [];
    });
    return { ...payload, messages };
  },
};

const ENCODERS = {
  "openai-responses": RESPONSES,
  "openai-codex-responses": RESPONSES,
  "anthropic-messages": ANTHROPIC,
  "openai-completions": COMPLETIONS,
} satisfies Record<PdfWireApi, PdfEncoder>;

/**
 * Pi's session message types carry only text and images. Keep PDFs out of those
 * messages and attach them at serialization, to the same user or tool result
 * that supplied them. A new turn starts with an empty set.
 */
export function createTurnPdfInput(
  model: PdfWireModel,
  delivery: Pick<FileDelivery, "pdf" | "refused">,
): TurnPdfInput {
  // `delivery` decides whether a PDF goes; the API only picks its wire format.
  const encoder: PdfEncoder | undefined =
    delivery.pdf && isPdfWireApi(model.api) ? ENCODERS[model.api] : undefined;
  const unsupported = delivery.refused.includes("pdf")
    ? `PDF not sent: ${FILE_INPUT_REFUSED_NOTE}.`
    : PDF_INPUT_UNSUPPORTED;
  const files: StoredFile[] = [];
  let remainingBytes = RESOURCE_BLOB_MAX_BYTES;

  const strip: Strip = (blocks, source, textType) => {
    const owned = new Set<StoredFile>();
    let changed = false;
    const kept = blocks.flatMap((block) => {
      if (block?.type !== textType || typeof block.text !== "string") return [block];
      if (!block.text.includes("[pdf:")) return [block];
      changed = true;
      let text: string = block.text;
      for (const file of files) {
        if (file.source !== source || !text.includes(file.receipt.reference)) continue;
        owned.add(file);
        text = text.replaceAll(file.receipt.reference, "");
      }
      // A reference this item does not own (another call's, or one copied into a summary) is
      // dropped, never sent as text.
      text = text.replace(REFERENCE, "").trim();
      return text ? [{ ...block, text }] : [];
    });
    return changed ? { blocks: kept, files: [...owned] } : undefined;
  };

  return {
    ...(encoder ? {} : { unsupported }),
    add({ name, data }, toolCallId) {
      if (!encoder) return { note: unsupported };
      const size = Buffer.byteLength(data, "base64");
      if (!size) return { note: "No PDF content was available." };
      const filename = sanitizeFilename(name);
      const source = toolCallId === undefined ? undefined : encoder.source(toolCallId);
      const duplicate = files.find(
        (f) => f.source === source && f.name === filename && f.data === data,
      );
      if (duplicate) return duplicate.receipt;
      if (size > remainingBytes) {
        return {
          note: "PDF omitted: the turn's inline file size limit was reached. Use an inline run to inspect it.",
        };
      }
      remainingBytes -= size;
      const receipt = {
        note: `PDF supplied to the model for this turn: ${filename}`,
        reference: `[pdf:${crypto.randomUUID()}]`,
      };
      files.push({ source, receipt, name: filename, data });
      return receipt;
    },
    extension(pi) {
      pi.on("before_provider_request", ({ payload }) => {
        if (!encoder || !files.length || !payload || typeof payload !== "object") return;
        return encoder.encode(payload as Message, strip, model.compat);
      });
    },
  };
}
