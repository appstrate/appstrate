// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { CHAT_FINAL_STEP_SYSTEM_PROMPT } from "@appstrate/core/chat-turn-metadata";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { createTurnPdfInput, type TurnPdfInput } from "../src/pi-chat/native-pdf.ts";

function transform(turn: TurnPdfInput, input: unknown[]) {
  let hook!: (event: { payload: { input: unknown[] } }) => { input: unknown[] } | undefined;
  turn.extension({
    on(event, callback) {
      expect(event).toBe("before_provider_request");
      hook = callback as typeof hook;
    },
  } as ExtensionAPI);
  return hook({ payload: { input } })?.input ?? input;
}

const VISION = { api: "openai-responses" as const, input: ["text", "image"] };

const pdf = { name: "contract.pdf", data: btoa("%PDF-1.7\ncontract") };
const nativeFile = {
  type: "input_file",
  filename: pdf.name,
  file_data: `data:application/pdf;base64,${pdf.data}`,
};

it("keeps attached and tool-returned PDFs on their source through the tool-less closing prompt", () => {
  const turn = createTurnPdfInput(VISION);
  const attachment = turn.add(pdf);
  const tool = turn.add(pdf, "call_1|fc_1");
  const text = (value: string) => ({ type: "input_text", text: value });
  const prompt = {
    role: "user",
    content: [text("Inspect the contract"), text(attachment.reference!)],
  };
  const historyPrompt = { role: "user", content: [text(attachment.note)] };
  const historyResult = { type: "function_call_output", call_id: "call_1", output: tool.note };
  // Responses joins the Pi text blocks of a tool-only result into a single string.
  const result = { ...historyResult, output: `${tool.reference}\n${tool.note}` };
  const closing = { role: "user", content: [text(CHAT_FINAL_STEP_SYSTEM_PROMPT)] };
  const input = [historyPrompt, historyResult, prompt, result, closing];
  const wire = transform(turn, input);
  expect(wire).toEqual([
    historyPrompt,
    historyResult,
    { ...prompt, content: [text("Inspect the contract"), nativeFile] },
    { ...result, output: [text(tool.note), nativeFile] },
    closing,
  ]);
  expect(JSON.stringify(input)).not.toContain(pdf.data);
  expect(JSON.stringify(wire)).not.toContain(tool.reference!);
  expect(JSON.stringify(wire)).not.toContain(attachment.reference!);
  const unrelated = [historyPrompt, historyResult, closing];
  expect(transform(turn, unrelated)).toEqual(unrelated);
  expect(transform(createTurnPdfInput(VISION), input)).toEqual(input);
});

it("caps cumulative file bytes before sending, including across function calls", () => {
  const turn = createTurnPdfInput(VISION);
  const full = { ...pdf, data: Buffer.alloc(RESOURCE_BLOB_MAX_BYTES).toString("base64") };
  const receipt = turn.add(full, "first|item");
  expect(receipt.note).toContain(pdf.name);
  expect(turn.add(full, "first|item")).toBe(receipt);
  expect(turn.add(pdf, "second|item").note).toContain("size limit");
  expect(createTurnPdfInput(VISION).add({ ...full, data: full.data + "AAAA" }).note).toContain(
    "size limit",
  );
});

it("reports an unsupported adapter without exposing the PDF as text", () => {
  const turn = createTurnPdfInput({ api: "openai-completions", input: ["text", "image"] });
  expect(turn.supported).toBe(false);
  const receipt = turn.add(pdf);
  expect(receipt.note).toContain("does not accept PDF");
  expect(receipt.note).not.toContain(pdf.data);
  const input = [{ role: "user", content: receipt.note }];
  expect(transform(turn, input)).toEqual(input);
});

it("has no PDF input on a model without vision, whatever its adapter", () => {
  const turn = createTurnPdfInput({ api: "openai-responses", input: ["text"] });
  expect(turn.supported).toBe(false);
  expect(turn.add(pdf).note).toContain("does not accept PDF");
});

it("attaches a PDF to its own call only, a grammar tool's output included, and drops a foreign reference", () => {
  const turn = createTurnPdfInput(VISION);
  const mine = turn.add(pdf, "call_a|fc_a");
  const text = (value: string) => ({ type: "input_text", text: value });
  // Call B carries call A's reference: it is not B's file, and it never reaches the wire as text.
  const other = { type: "function_call_output", call_id: "call_b", output: `B ${mine.reference}` };
  const custom = { type: "custom_tool_call_output", call_id: "call_a", output: mine.reference! };
  const assistant = { role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const plain = { role: "user", content: [text("no reference here ")] };
  const wire = transform(turn, [other, custom, assistant, plain]);
  expect(wire).toEqual([
    { ...other, output: [text("B")] },
    { ...custom, output: [nativeFile] },
    assistant,
    plain,
  ]);
  expect(JSON.stringify(wire)).not.toContain("[pdf:");
});
