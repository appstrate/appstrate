// SPDX-License-Identifier: Apache-2.0

import { sanitizeFilename } from "@appstrate/core/naming";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import type { ExtensionFactory } from "@appstrate/runner-pi";
import type { FileDelivery } from "../file-input.ts";

/** A one-turn reference to a PDF, swapped for the file itself at serialization. */
const REFERENCE = /\[pdf:[0-9a-f-]{36}\]/g;

/** Items of a Responses request that carry a tool's output: plain and grammar (custom) tools. */
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

export const PDF_INPUT_UNSUPPORTED =
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
  supported: boolean;
  /** Without a tool call id, the PDF belongs to the current user message. */
  add(file: PdfFile, toolCallId?: string): PdfReceipt;
  extension: ExtensionFactory;
}

/**
 * Pi's session message types carry only text and images. Keep PDFs out of those
 * messages and attach them at serialization, to the same user or tool result
 * that supplied them. A new turn starts with an empty set.
 */
export function createTurnPdfInput(delivery: FileDelivery): TurnPdfInput {
  const supported = delivery.pdf;
  const files: {
    source?: string;
    receipt: PdfReceipt & { reference: string };
    name: string;
    data: string;
  }[] = [];
  let remainingBytes = RESOURCE_BLOB_MAX_BYTES;

  return {
    supported,
    add({ name, data }, toolCallId) {
      if (!supported) return { note: PDF_INPUT_UNSUPPORTED };
      const size = Buffer.byteLength(data, "base64");
      if (!size) return { note: "No PDF content was available." };
      const filename = sanitizeFilename(name);
      // Pi pairs Responses calls as "call_id|item_id"; only call_id goes on the wire.
      const source = toolCallId?.split("|", 1)[0];
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
        if (
          !files.length ||
          !payload ||
          typeof payload !== "object" ||
          !("input" in payload) ||
          !Array.isArray(payload.input)
        )
          return;
        const input = payload.input.map((item) => {
          const user = item?.role === "user";
          if (!user && !TOOL_OUTPUT_TYPES.has(item?.type)) return item;
          const content = user ? item.content : item.output;
          const parts =
            typeof content === "string" ? [{ type: "input_text", text: content }] : content;
          if (!Array.isArray(parts)) return item;
          const source = user ? undefined : item.call_id;
          const attached = new Set<(typeof files)[number]>();
          const cleaned = parts.flatMap((part) => {
            if (part?.type !== "input_text" || typeof part.text !== "string") return [part];
            if (!part.text.includes("[pdf:")) return [part];
            let text: string = part.text;
            for (const file of files) {
              if (file.source !== source || !text.includes(file.receipt.reference)) continue;
              attached.add(file);
              text = text.replaceAll(file.receipt.reference, "");
            }
            // A reference this item does not own (another call's, or one copied into a summary) is
            // dropped, never sent as text.
            text = text.replace(REFERENCE, "").trim();
            return text ? [{ ...part, text }] : [];
          });
          if (cleaned.length === parts.length && cleaned.every((part, i) => part === parts[i])) {
            return item;
          }
          const native = Array.from(attached, (file) => ({
            type: "input_file",
            filename: file.name,
            file_data: `data:application/pdf;base64,${file.data}`,
          }));
          return { ...item, [user ? "content" : "output"]: [...cleaned, ...native] };
        });
        return { ...payload, input };
      });
    },
  };
}
