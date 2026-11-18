// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { payloadTooLarge } from "@appstrate/core/api-errors";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import {
  createFileRefusal,
  fileKindsIn,
  mayBeFileRefusal,
  withholdFiles,
} from "../src/pi-chat/file-refusal.ts";

const text = { type: "text", text: "hi" };
const image = { type: "image", source: { type: "base64", data: "AAAA" } };
const withImage = { messages: [{ role: "user", content: [text, image] }] };

describe("fileKindsIn", () => {
  it("finds image and PDF parts in messages, tool results and Responses items", () => {
    expect(fileKindsIn({ messages: [{ role: "user", content: [text] }] }).size).toBe(0);
    expect(fileKindsIn({ messages: [{ role: "user", content: "plain" }] }).size).toBe(0);
    for (const [type, kind] of [
      ["image", "image"],
      ["image_url", "image"],
      ["document", "pdf"],
      ["file", "pdf"],
    ]) {
      expect([...fileKindsIn({ messages: [{ role: "user", content: [text, { type }] }] })]).toEqual(
        [kind],
      );
    }
    expect([
      ...fileKindsIn({
        messages: [
          { role: "user", content: [{ type: "tool_result", content: [{ type: "image" }] }] },
        ],
      }),
    ]).toEqual(["image"]);
    expect([
      ...fileKindsIn({
        input: [
          { role: "user", content: [{ type: "input_image" }] },
          { type: "function_call_output", output: [{ type: "input_file" }] },
        ],
      }),
    ]).toEqual(["image", "pdf"]);
  });

  it("ignores tool schemas and a tool call's own arguments", () => {
    const payload = {
      tools: [{ type: "file" }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", input: { type: "image" } }] }],
    };
    expect(fileKindsIn(payload).size).toBe(0);
  });
});

describe("withholdFiles", () => {
  it("replaces only the withheld kinds with a pointer, in the API's text type", () => {
    const pdf = { type: "document", source: { data: "BBBB" } };
    const payload = {
      model: "m",
      messages: [
        { role: "user", content: [text, { ...image, cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [pdf] }] },
      ],
    };
    expect(withholdFiles(payload, new Set(["image"]), "anthropic-messages")).toEqual({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            text,
            {
              type: "text",
              text: "[file withheld: the model refused it]",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        payload.messages[1],
      ],
    });
    const responses = {
      input: [{ type: "function_call_output", output: [{ type: "input_file" }] }],
    };
    expect(withholdFiles(responses, new Set(["pdf"]), "openai-responses")).toEqual({
      input: [
        {
          type: "function_call_output",
          output: [{ type: "input_text", text: "[file withheld: the model refused it]" }],
        },
      ],
    });
  });
});

describe("mayBeFileRefusal", () => {
  it("holds for an invalid request", () => {
    expect(mayBeFileRefusal("400 Invalid image data")).toBe(true);
    // A non-file 4xx is a suspect too: the replay decides.
    expect(mayBeFileRefusal("400 Unsupported parameter: 'temperature'")).toBe(true);
  });

  it("does not hold for the llm-proxy's body limit, which pi-ai reads as an overflow", () => {
    // What the OpenAI SDK makes of the problem+json `bodyLimit` answers (`apps/api`).
    const problem = payloadTooLarge("Request body exceeds the 10485760-byte limit").toProblemDetail(
      "req_1",
    );
    expect(mayBeFileRefusal(`413 ${JSON.stringify(problem)}`)).toBe(false);
  });

  it("does not hold for a context overflow, auth or throttling", () => {
    expect(mayBeFileRefusal("400 prompt is too long: 250000 tokens > 200000 maximum")).toBe(false);
    expect(mayBeFileRefusal("401 invalid x-api-key")).toBe(false);
    expect(mayBeFileRefusal("429 Too many requests")).toBe(false);
  });
});

/** A fake `pi` that records the handlers, and the events of one step. */
function harness() {
  const refusal = createFileRefusal("anthropic-messages");
  const handlers = new Map<string, (event: unknown) => unknown>();
  refusal.extension({
    on(event: string, handler: (event: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);
  const send = (payload: unknown) => handlers.get("before_provider_request")!({ payload });
  const end = (stopReason: string, errorMessage?: string) =>
    handlers.get("turn_end")!({ message: { role: "assistant", stopReason, errorMessage } });
  const settle = (outcome = "error") =>
    handlers.get("agent_before_settle")!({
      outcome,
      context: {
        contextEntries: [
          { sourceEntry: { type: "message", id: "e1", message: { role: "user" } } },
          {
            sourceEntry: {
              type: "message",
              id: "e2",
              message: { role: "assistant", stopReason: "error" },
            },
          },
        ],
      },
    });
  return { refusal, send, end, settle };
}

const REPLAY = {
  entries: [{ type: "context_edit", targetId: "e2", replacement: null }],
  continue: true,
};

describe("createFileRefusal", () => {
  it("replays a refused request once without its files, and records the kind on success", () => {
    const { refusal, send, end, settle } = harness();
    expect(send(withImage)).toBeUndefined();
    end("error", "400 Could not process image");
    expect(settle()).toEqual(REPLAY);
    const replayed = send(withImage);
    expect(fileKindsIn(replayed).size).toBe(0);
    expect(JSON.stringify(replayed)).toContain("[file withheld: the model refused it]");
    end("stop");
    expect(refusal.refusedKinds()).toEqual(["image"]);
    expect(refusal.originalError()).toBeUndefined();
    // The rest of the turn goes without it too.
    expect(fileKindsIn(send(withImage)).size).toBe(0);
  });

  it("keeps the first error and records nothing when the replay fails too", () => {
    const { refusal, send, end, settle } = harness();
    send(withImage);
    end("error", "400 Unsupported parameter: 'temperature'");
    expect(settle()).toEqual(REPLAY);
    send(withImage);
    end("error", "400 Unsupported parameter: 'temperature' (again)");
    expect(settle()).toBeUndefined();
    expect(refusal.refusedKinds()).toEqual([]);
    expect(refusal.originalError()).toBe("400 Unsupported parameter: 'temperature'");
  });

  it("replays nothing without a file, for an overflow, for a stop or for a 5xx", () => {
    for (const [payload, error, outcome] of [
      [{ messages: [{ role: "user", content: [text] }] }, "400 Invalid request", "error"],
      [withImage, "413 status code (no body)", "error"],
      [withImage, "503 Service unavailable", "error"],
      [withImage, "400 Could not process image", "aborted"],
    ] as const) {
      const { refusal, send, end, settle } = harness();
      send(payload);
      end("error", error);
      expect(settle(outcome)).toBeUndefined();
      expect(refusal.refusedKinds()).toEqual([]);
    }
  });
});
