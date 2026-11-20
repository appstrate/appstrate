// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { CHAT_FINAL_STEP_SYSTEM_PROMPT } from "@appstrate/core/chat-turn-metadata";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { fileDelivery } from "../src/file-input.ts";
import { createTurnPdfInput, type TurnPdfInput } from "../src/pi-chat/native-pdf.ts";

type Payload = Record<string, unknown[]>;

/** The request payload after the turn's `before_provider_request` hook, read under `key`. */
function serialize(turn: TurnPdfInput, key: string, items: unknown[]) {
  let hook!: (event: { payload: Payload }) => Payload | undefined;
  turn.extension({
    on(event, callback) {
      expect(event).toBe("before_provider_request");
      hook = callback as typeof hook;
    },
  } as ExtensionAPI);
  return hook({ payload: { [key]: items } })?.[key] ?? items;
}

const transform = (turn: TurnPdfInput, input: unknown[]) => serialize(turn, "input", input);

interface TestModel {
  api: string | null;
  input: string[] | null;
  compat?: unknown;
}

/** The turn the engine builds for a model. */
const turnFor = (model: TestModel) => {
  const delivery = fileDelivery(model);
  const turn = createTurnPdfInput(model, delivery);
  expect(turn.unsupported === undefined).toBe(delivery.pdf);
  return turn;
};

const VISION: TestModel = { api: "openai-responses", input: ["text", "image"] };

const pdf = { name: "contract.pdf", data: btoa("%PDF-1.7\ncontract") };
const nativeFile = {
  type: "input_file",
  filename: pdf.name,
  file_data: `data:application/pdf;base64,${pdf.data}`,
};

describe("openai-responses", () => {
  it("keeps attached and tool-returned PDFs on their source through the tool-less closing prompt", () => {
    const turn = turnFor(VISION);
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
    expect(transform(turnFor(VISION), input)).toEqual(input);
  });

  it("attaches a PDF to its own call only, a grammar tool's output included, and drops a foreign reference", () => {
    const turn = turnFor(VISION);
    const mine = turn.add(pdf, "call_a|fc_a");
    const text = (value: string) => ({ type: "input_text", text: value });
    // Call B carries call A's reference: it is not B's file, and it never reaches the wire as text.
    const other = {
      type: "function_call_output",
      call_id: "call_b",
      output: `B ${mine.reference}`,
    };
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

  it("sends a Codex call's PDF in the Responses shape, keyed by its call_id", () => {
    const turn = turnFor({ api: "openai-codex-responses", input: null });
    const tool = turn.add(pdf, "call_c|fc_c");
    const item = { type: "function_call_output", call_id: "call_c", output: tool.reference };
    expect(transform(turn, [item])).toEqual([{ ...item, output: [nativeFile] }]);
  });
});

it("caps cumulative file bytes before sending, including across function calls", () => {
  const turn = turnFor(VISION);
  const full = { ...pdf, data: Buffer.alloc(RESOURCE_BLOB_MAX_BYTES).toString("base64") };
  const receipt = turn.add(full, "first|item");
  expect(receipt.note).toContain(pdf.name);
  expect(turn.add(full, "first|item")).toBe(receipt);
  expect(turn.add(pdf, "second|item").note).toContain("size limit");
  expect(turnFor(VISION).add({ ...full, data: full.data + "AAAA" }).note).toContain("size limit");
});

it("reports a PDF the turn does not deliver, with its cause, without exposing it as text", () => {
  const cases: [TestModel, string][] = [
    [{ api: "mistral-conversations", input: ["text", "image"] }, "has no PDF input format"],
    // Providers read a PDF's pages as images: a text-only model reads none.
    [{ api: "openai-responses", input: ["text"] }, "declared without image input"],
  ];
  for (const [model, cause] of cases) {
    const turn = turnFor(model);
    expect(turn.unsupported).toContain(cause);
    const receipt = turn.add(pdf);
    expect(receipt.reference).toBeUndefined();
    expect(receipt.note).toBe(turn.unsupported!);
    expect(receipt.note).toEndWith("Use an inline run to inspect the file.");
    expect(receipt.note).not.toContain(pdf.data);
    const input = [{ role: "user", content: receipt.note }];
    expect(transform(turn, input)).toEqual(input);
  }
});

it("treats a PDF the rule lets through on an API without an encoder as unsupported", () => {
  for (const api of [null, "mistral-conversations"]) {
    const turn = createTurnPdfInput({ api }, { pdf: true });
    expect(turn.unsupported).toContain("has no PDF input format");
    expect(turn.add(pdf).reference).toBeUndefined();
  }
});

const CACHE = { type: "ephemeral" };
const text = (value: string) => ({ type: "text", text: value });

describe("anthropic-messages", () => {
  const ANTHROPIC: TestModel = { api: "anthropic-messages", input: ["text", "image"] };
  const document = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: pdf.data },
  };
  const messages = (turn: TurnPdfInput, items: unknown[]) => serialize(turn, "messages", items);

  it("appends the attached PDF to its user message and keeps the cache mark on the last block", () => {
    const turn = turnFor(ANTHROPIC);
    const attachment = turn.add(pdf);
    const earlier = { role: "user", content: "earlier question" };
    const assistant = { role: "assistant", content: [text("ok")] };
    // pi-ai turns the last user message's string into blocks and marks the last one.
    const prompt = {
      role: "user",
      content: [
        text("Inspect the contract"),
        { ...text(attachment.reference!), cache_control: CACHE },
      ],
    };
    const wire = messages(turn, [earlier, assistant, prompt]);
    expect(wire).toEqual([
      earlier,
      assistant,
      {
        role: "user",
        content: [text("Inspect the contract"), { ...document, cache_control: CACHE }],
      },
    ]);
    expect(wire[0]).toBe(earlier);
    expect(wire[1]).toBe(assistant);
    // String content, as pi-ai writes a user message it does not mark.
    expect(messages(turn, [{ role: "user", content: attachment.reference }])).toEqual([
      { role: "user", content: [document] },
    ]);
  });

  it("puts a tool's PDF in its own tool_result, an error result's after the results", () => {
    const turn = turnFor(ANTHROPIC);
    const mine = turn.add(pdf, "toolu_a");
    const failed = turn.add({ ...pdf, data: btoa("%PDF-1.7 failed") }, "toolu_e");
    const result = (id: string, content: unknown, extra = {}) => ({
      type: "tool_result",
      tool_use_id: id,
      content,
      is_error: false,
      ...extra,
    });
    const step = {
      role: "user",
      content: [
        result("toolu_a", `${mine.reference}\n${mine.note}`),
        result("toolu_e", [text(`failed ${failed.reference}`)], { is_error: true }),
        result("toolu_b", `B ${mine.reference}`),
        result("toolu_c", "untouched", { cache_control: CACHE }),
      ],
    };
    const wire = messages(turn, [step]);
    expect(wire).toEqual([
      {
        role: "user",
        content: [
          result("toolu_a", [text(mine.note), document]),
          result("toolu_e", [text("failed")], { is_error: true }),
          result("toolu_b", [text("B")]),
          result("toolu_c", "untouched"),
          text("PDFs from the error result of tool call toolu_e:"),
          {
            ...document,
            source: { ...document.source, data: btoa("%PDF-1.7 failed") },
            cache_control: CACHE,
          },
        ],
      },
    ]);
    expect(JSON.stringify(wire)).not.toContain("[pdf:");
  });

  it("leaves a request that references no PDF untouched", () => {
    const turn = turnFor(ANTHROPIC);
    turn.add(pdf);
    const items = [
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
    ];
    const wire = messages(turn, items);
    items.forEach((item, i) => expect(wire[i]).toBe(item));
  });
});

describe("openai-completions", () => {
  const COMPLETIONS: TestModel = { api: "openai-completions", input: ["text", "image"] };
  const BRIDGED: TestModel = { ...COMPLETIONS, compat: { requiresAssistantAfterToolResult: true } };
  const file = {
    type: "file",
    file: { filename: pdf.name, file_data: `data:application/pdf;base64,${pdf.data}` },
  };
  const messages = (turn: TurnPdfInput, items: unknown[]) => serialize(turn, "messages", items);
  const calls = { role: "assistant", content: null, tool_calls: [{ id: "call_a" }] };
  const tool = (id: string, content: unknown) => ({ role: "tool", content, tool_call_id: id });
  const caption = text("Attached PDF(s) from tool result:");
  const pdfMessage = { role: "user", content: [caption, file] };
  const imageFollowUp = {
    role: "user",
    content: [
      text("Attached image(s) from tool result:"),
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  };
  const bridge = { role: "assistant", content: "I have processed the tool results." };

  it("adds the attached PDF as a file part and keeps the cache mark on the last text part", () => {
    const turn = turnFor(COMPLETIONS);
    const attachment = turn.add(pdf);
    const prompt = {
      role: "user",
      content: [
        text("Inspect the contract"),
        { ...text(attachment.reference!), cache_control: CACHE },
      ],
    };
    expect(messages(turn, [prompt])).toEqual([
      { role: "user", content: [{ ...text("Inspect the contract"), cache_control: CACHE }, file] },
    ]);
    expect(messages(turn, [{ role: "user", content: attachment.reference }])).toEqual([
      { role: "user", content: [file] },
    ]);
  });

  it("moves a tool's PDF out of the text-only tool message into a user message after the run", () => {
    const turn = turnFor(COMPLETIONS);
    const mine = turn.add(pdf, "call_a");
    const next = { role: "user", content: "next" };
    const wire = messages(turn, [
      calls,
      tool("call_a", `${mine.reference}\n${mine.note}`),
      tool("call_b", `B ${mine.reference}`),
      next,
    ]);
    expect(wire).toEqual([calls, tool("call_a", mine.note), tool("call_b", "B"), pdfMessage, next]);
  });

  it("joins pi-ai's tool image message, bridged or not", () => {
    for (const model of [COMPLETIONS, BRIDGED]) {
      const turn = turnFor(model);
      const mine = turn.add(pdf, "call_a");
      const bridging = model.compat ? [bridge] : [];
      const run = [calls, tool("call_a", mine.reference), ...bridging];
      expect(messages(turn, [...run, imageFollowUp])).toEqual([
        calls,
        tool("call_a", "(see attached PDF)"),
        ...bridging,
        { ...imageFollowUp, content: [...imageFollowUp.content, file] },
      ]);
    }
  });

  it("bridges its own PDF message when the provider requires an assistant after tool results", () => {
    const turn = turnFor(BRIDGED);
    const mine = turn.add(pdf, "call_a");
    const next = { role: "user", content: "next" };
    expect(messages(turn, [calls, tool("call_a", mine.reference), bridge, next])).toEqual([
      calls,
      tool("call_a", "(see attached PDF)"),
      bridge,
      pdfMessage,
      bridge,
      next,
    ]);
  });

  it("hands pi-ai's cache mark from the last tool message to the PDF message that now ends the request", () => {
    for (const model of [COMPLETIONS, BRIDGED]) {
      const turn = turnFor(model);
      const mine = turn.add(pdf, "call_a");
      // pi-ai marks the last conversation message, here the tool message, as a text part.
      const marked = tool("call_a", [{ ...text(mine.reference!), cache_control: CACHE }]);
      expect(messages(turn, [calls, marked])).toEqual([
        calls,
        tool("call_a", "(see attached PDF)"),
        ...(model.compat ? [bridge] : []),
        { role: "user", content: [{ ...caption, cache_control: CACHE }, file] },
      ]);
    }
    // A tool message that only drops a foreign reference keeps its mark.
    const turn = turnFor(COMPLETIONS);
    const mine = turn.add(pdf, "call_a");
    const foreign = tool("call_b", [{ ...text(`B ${mine.reference}`), cache_control: CACHE }]);
    expect(messages(turn, [calls, foreign])).toEqual([
      calls,
      tool("call_b", [{ ...text("B"), cache_control: CACHE }]),
    ]);
  });

  it("leaves a request that references no PDF untouched", () => {
    const turn = turnFor(COMPLETIONS);
    turn.add(pdf, "call_a");
    const items = [calls, tool("call_a", "plain"), imageFollowUp, { role: "user", content: "x" }];
    const wire = messages(turn, items);
    expect(wire).toHaveLength(items.length);
    items.forEach((item, i) => expect(wire[i]).toBe(item));
  });
});
