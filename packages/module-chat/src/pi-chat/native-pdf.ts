// SPDX-License-Identifier: Apache-2.0

import { sanitizeFilename } from "@appstrate/core/naming";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import type { Api, ExtensionFactory } from "@appstrate/runner-pi";

export const PDF_INPUT_UNSUPPORTED =
  "This model's chat adapter does not accept PDF input. Use an inline run to inspect the file.";

interface PdfFile {
  name: string;
  data: string;
}

export interface TurnPdfInput {
  supported: boolean;
  /** Without a tool call id, the PDF belongs to the current user message. */
  add(file: PdfFile, toolCallId?: string): string;
  extension: ExtensionFactory;
}

/**
 * Pi's session message types carry only text and images. Keep PDFs out of those
 * messages and attach them at serialization, to the same user or tool result
 * that supplied them. A new turn starts with an empty set.
 */
export function createTurnPdfInput(api: Api): TurnPdfInput {
  const supported = api === "openai-responses";
  const files: { source?: string; receipt: string; name: string; data: string }[] = [];
  let remainingBytes = RESOURCE_BLOB_MAX_BYTES;

  return {
    supported,
    add({ name, data }, toolCallId) {
      if (!supported) return PDF_INPUT_UNSUPPORTED;
      const size = Buffer.byteLength(data, "base64");
      if (!size) return "No PDF content was available.";
      const filename = sanitizeFilename(name);
      // Pi pairs Responses calls as "call_id|item_id"; only call_id goes on the wire.
      const source = toolCallId?.split("|", 1)[0];
      const duplicate = files.find(
        (f) => f.source === source && f.name === filename && f.data === data,
      );
      if (duplicate) return duplicate.receipt;
      if (size > remainingBytes) {
        return "PDF omitted: the turn's inline file size limit was reached. Use an inline run to inspect it.";
      }
      remainingBytes -= size;
      const receipt = `PDF supplied to the model for this turn: ${filename}`;
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
        const currentUser = payload.input.findLastIndex((item) => item?.role === "user");
        if (currentUser < 0) return;
        const input = payload.input.map((item, index) => {
          // A provider can reuse a call id that already appears in replayed history.
          if (index < currentUser) return item;
          const user = index === currentUser;
          if (!user && item?.type !== "function_call_output") return item;
          const content = user ? item.content : item.output;
          const parts =
            typeof content === "string" ? [{ type: "input_text", text: content }] : content;
          if (!Array.isArray(parts)) return item;
          const attached = files.filter((file) =>
            user
              ? file.source === undefined &&
                parts.some(
                  (p) =>
                    p?.type === "input_text" &&
                    typeof p.text === "string" &&
                    p.text.includes(file.receipt),
                )
              : file.source !== undefined && file.source === item.call_id,
          );
          if (!attached.length) return item;
          const native = attached.map((file) => ({
            type: "input_file",
            filename: file.name,
            file_data: `data:application/pdf;base64,${file.data}`,
          }));
          return { ...item, [user ? "content" : "output"]: [...parts, ...native] };
        });
        return { ...payload, input };
      });
    },
  };
}
