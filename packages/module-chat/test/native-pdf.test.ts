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

const pdf = { name: "contract.pdf", data: btoa("%PDF-1.7\ncontract") };
const nativeFile = {
  type: "input_file",
  filename: pdf.name,
  file_data: `data:application/pdf;base64,${pdf.data}`,
};

it("keeps attached and tool-returned PDFs on their source through the tool-less closing prompt", () => {
  const turn = createTurnPdfInput("openai-responses");
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
    { ...result, output: [text(`\n${tool.note}`), nativeFile] },
    closing,
  ]);
  expect(JSON.stringify(input)).not.toContain(pdf.data);
  expect(JSON.stringify(wire)).not.toContain(tool.reference!);
  expect(JSON.stringify(wire)).not.toContain(attachment.reference!);
  const unrelated = [historyPrompt, historyResult, closing];
  expect(transform(turn, unrelated)).toEqual(unrelated);
  expect(transform(createTurnPdfInput("openai-responses"), input)).toEqual(input);
});

it("caps cumulative file bytes before sending, including across function calls", () => {
  const turn = createTurnPdfInput("openai-responses");
  const full = { ...pdf, data: Buffer.alloc(RESOURCE_BLOB_MAX_BYTES).toString("base64") };
  const receipt = turn.add(full, "first|item");
  expect(receipt.note).toContain(pdf.name);
  expect(turn.add(full, "first|item")).toBe(receipt);
  expect(turn.add(pdf, "second|item").note).toContain("size limit");
  expect(
    createTurnPdfInput("openai-responses").add({ ...full, data: full.data + "AAAA" }).note,
  ).toContain("size limit");
});

it("reports an unsupported adapter without exposing the PDF as text", () => {
  const turn = createTurnPdfInput("openai-completions");
  expect(turn.supported).toBe(false);
  const receipt = turn.add(pdf);
  expect(receipt.note).toContain("does not accept PDF");
  expect(receipt.note).not.toContain(pdf.data);
  const input = [{ role: "user", content: receipt.note }];
  expect(transform(turn, input)).toEqual(input);
});
