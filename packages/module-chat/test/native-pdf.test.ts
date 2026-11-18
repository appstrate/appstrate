// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
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

it("attaches PDF bytes only to the live user message and the function result that returned them", () => {
  const turn = createTurnPdfInput("openai-responses");
  const receipt = turn.add(pdf);
  const toolReceipt = turn.add(pdf, "call_1|fc_1");
  const prompt = { role: "user", content: [{ type: "input_text", text: receipt }] };
  const other = { type: "function_call_output", call_id: "another", output: toolReceipt };
  const result = { type: "function_call_output", call_id: "call_1", output: toolReceipt };
  const input = [prompt, prompt, other, result];
  expect(transform(turn, input)).toEqual([
    prompt,
    { ...prompt, content: [...prompt.content, nativeFile] },
    other,
    { ...result, output: [{ type: "input_text", text: toolReceipt }, nativeFile] },
  ]);
  expect(JSON.stringify(input)).not.toContain(pdf.data);
  expect(transform(createTurnPdfInput("openai-responses"), input)).toEqual(input);
  const unrelated = [
    { role: "user", content: [{ type: "input_text", text: "Summarize the chat" }] },
  ];
  expect(transform(turn, unrelated)).toEqual(unrelated);
});

it("caps cumulative file bytes before sending, including across function calls", () => {
  const turn = createTurnPdfInput("openai-responses");
  const full = { ...pdf, data: Buffer.alloc(RESOURCE_BLOB_MAX_BYTES).toString("base64") };
  const receipt = turn.add(full, "first|item");
  expect(receipt).toContain(pdf.name);
  expect(turn.add(full, "first|item")).toBe(receipt);
  expect(turn.add(pdf, "second|item")).toContain("size limit");
  expect(
    createTurnPdfInput("openai-responses").add({ ...full, data: full.data + "AAAA" }),
  ).toContain("size limit");
});

it("reports an unsupported adapter without exposing the PDF as text", () => {
  const turn = createTurnPdfInput("openai-completions");
  expect(turn.supported).toBe(false);
  const receipt = turn.add(pdf);
  expect(receipt).toContain("does not accept PDF");
  expect(receipt).not.toContain(pdf.data);
  const input = [{ role: "user", content: receipt }];
  expect(transform(turn, input)).toEqual(input);
});
