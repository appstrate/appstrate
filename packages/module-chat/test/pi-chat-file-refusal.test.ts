// SPDX-License-Identifier: Apache-2.0

// The engine's real converters and encoders are driven in `pi-chat-engine-live.test.ts`; these
// payloads pin the walk itself: where a file can sit, and what is never rewritten.

import { describe, expect, it } from "bun:test";
import { payloadTooLarge } from "@appstrate/core/api-errors";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { createFileRefusal } from "../src/pi-chat/file-refusal.ts";

const IMAGE_POINTER = "[image withheld: this model rejected it; any other file was delivered]";
const PDF_POINTER = "[PDF withheld: this model rejected it; any other file was delivered]";
const text = { type: "text", text: "hi" };
const image = { type: "image", source: { type: "base64", data: "AAAA" } };
const pdf = { type: "document", source: { type: "base64", data: "BBBB" } };
const withImage = { messages: [{ role: "user", content: [text, image] }] };
const responsesImage = { input: [{ role: "user", content: [{ type: "input_image" }] }] };
const completionsImage = {
  messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
};
const withBoth = {
  messages: [
    { role: "user", content: [text, image] },
    { role: "user", content: [text, pdf] },
  ],
};

/** A fake `pi` that records the handlers, and drives the events of one step. */
function harness(api = "anthropic-messages") {
  let replays = 0;
  const refusal = createFileRefusal(api, () => replays++);
  const handlers = new Map<string, (event: unknown) => unknown>();
  refusal.extension({
    on(event: string, handler: (event: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);
  /** The payload as it reaches the wire. */
  const send = (payload: unknown) =>
    handlers.get("before_provider_request")!({ payload }) ?? payload;
  const end = (stopReason: string, errorMessage?: string, provider = "anthropic") =>
    handlers.get("turn_end")!({
      message: { role: "assistant", stopReason, errorMessage, provider },
    });
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
  /** One failed request with `payload`, settled: whether a replay was asked for. */
  const fail = (payload: unknown, error: string, provider?: string) => {
    send(payload);
    end("error", error, provider);
    return settle() !== undefined;
  };
  return { refusal, send, end, settle, fail, replays: () => replays };
}

const REPLAY = {
  entries: [{ type: "context_edit", targetId: "e2", replacement: null }],
  continue: true,
};

describe("which failures are replayed", () => {
  it("replays an invalid request that carried a file, a non-file 4xx included", () => {
    expect(harness().fail(withImage, "400 Invalid image data")).toBe(true);
    expect(harness().fail(withImage, "400 Unsupported parameter: 'temperature'")).toBe(true);
  });

  it("replays a failure with no status, the way Codex reports a refused file", () => {
    for (const error of [
      "Invalid file data: 'file_data'. Expected a base64-encoded data URL with a MIME type.",
      "Codex error: invalid_request_error",
    ]) {
      expect(harness("openai-codex-responses").fail(responsesImage, error)).toBe(true);
    }
  });

  it("does not replay a failure that carried no file", () => {
    expect(harness().fail({ messages: [{ role: "user", content: [text] }] }, "400 bad")).toBe(
      false,
    );
  });

  it("finds files in each API's shapes, nested tool outputs included", () => {
    const cases: [string, unknown][] = [
      [
        "anthropic-messages",
        { messages: [{ role: "user", content: [{ type: "tool_result", content: [image] }] }] },
      ],
      ["openai-completions", completionsImage],
      ["mistral-conversations", completionsImage],
      [
        "openai-completions",
        { messages: [{ role: "user", content: [{ type: "file", file: { file_data: "x" } }] }] },
      ],
      [
        "openai-responses",
        { input: [{ type: "function_call_output", output: [{ type: "input_file" }] }] },
      ],
      ["openai-responses", responsesImage],
    ];
    for (const [api, payload] of cases) expect(harness(api).fail(payload, "400 bad")).toBe(true);
  });

  it("reads only the API's own part types, and nothing on an API it has none for", () => {
    expect(harness("anthropic-messages").fail(completionsImage, "400 bad")).toBe(false);
    expect(harness("mistral-conversations").fail(withBoth, "400 bad")).toBe(false);
    const { send, fail } = harness("google-generative-ai");
    expect(fail(withImage, "400 bad")).toBe(false);
    expect(send(withImage)).toBe(withImage);
  });

  it("never reads a file in tool schemas or in a tool call's arguments", () => {
    const noFile = {
      tools: [{ type: "file" }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", input: { type: "image" } }] }],
    };
    expect(harness().fail(noFile, "400 bad")).toBe(false);
  });

  it("does not replay the llm-proxy's body limit, an overflow, auth, throttling or a 5xx", () => {
    // What the OpenAI SDK makes of the problem+json `bodyLimit` answers (`apps/api`).
    const problem = payloadTooLarge("Request body exceeds the 10485760-byte limit").toProblemDetail(
      "req_1",
    );
    for (const error of [
      `413 ${JSON.stringify(problem)}`,
      "400 prompt is too long: 250000 tokens > 200000 maximum",
      "401 invalid x-api-key",
      "429 Too many requests",
      "503 Service unavailable",
      "408 Request Timeout",
      "409 Conflict",
      "fetch failed",
      "Connection error.",
      "Codex response failed: stream disconnected before completion",
    ]) {
      expect(harness().fail(withImage, error)).toBe(false);
    }
  });

  it("does not replay Cerebras's bodyless overflow, as Pi reads it", () => {
    for (const error of ["400 status code (no body)", "413 status code (no body)"]) {
      expect(harness("openai-completions").fail(completionsImage, error, "cerebras")).toBe(false);
    }
  });

  it("does not replay a stopped turn", () => {
    const { send, end, settle } = harness();
    send(withImage);
    end("error", "400 Could not process image");
    expect(settle("aborted")).toBeUndefined();
  });
});

describe("the replay", () => {
  it("withholds the refused kind for the rest of the turn and names it on success", () => {
    const { refusal, send, end, fail, replays } = harness();
    expect(fail(withImage, "400 Could not process image")).toBe(true);
    expect(replays()).toBe(1);
    expect(send(withImage)).toEqual({
      messages: [{ role: "user", content: [text, { type: "text", text: IMAGE_POINTER }] }],
    });
    end("stop");
    expect(refusal.refusedKinds()).toEqual(["image"]);
    expect(refusal.originalError()).toBeUndefined();
    // A later request of the same turn.
    expect(JSON.stringify(send(withImage))).not.toContain("AAAA");
  });

  it("writes the pointer in the Responses text type and keeps the cache mark", () => {
    const { send, fail } = harness("openai-responses");
    const marked = { type: "input_image", image_url: "x", cache_control: { type: "ephemeral" } };
    fail({ input: [{ role: "user", content: [marked] }] }, "400 bad image");
    expect(send({ input: [{ role: "user", content: [marked] }] })).toEqual({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: IMAGE_POINTER, cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
  });

  it("never rewrites a tool call's arguments", () => {
    const { send, fail } = harness();
    const call = { type: "tool_use", id: "t1", name: "x", input: { content: [image] } };
    const payload = { messages: [{ role: "assistant", content: [call] }, withImage.messages[0]] };
    fail(payload, "400 bad image");
    expect((send(payload) as typeof payload).messages[0]).toEqual(payload.messages[0]);
  });

  it("succeeds when Pi's own retry of a transiently failed replay succeeds", () => {
    const { refusal, send, end, settle, fail } = harness();
    fail(withImage, "400 Could not process image");
    send(withImage);
    end("error", "503 Service unavailable");
    // Pi retries the 503 itself before settling; that retry succeeds.
    send(withImage);
    end("stop");
    expect(settle("completed")).toBeUndefined();
    expect(refusal.refusedKinds()).toEqual(["image"]);
  });

  it("reports the replay's own error when it fails otherwise", () => {
    const { refusal, send, end, settle, fail } = harness();
    fail(withImage, "400 Could not process image");
    send(withImage);
    end("error", "503 Service unavailable");
    expect(settle()).toBeUndefined();
    expect(refusal.originalError()).toBeUndefined();
    expect(refusal.refusedKinds()).toEqual([]);
  });

  it("keeps the first error when the replay is refused the same way", () => {
    const { refusal, send, end, settle, fail } = harness();
    fail(withImage, "400 Unsupported parameter: 'temperature'");
    send(withImage);
    end("error", "400 Unsupported parameter: 'temperature' (again)");
    expect(settle()).toBeUndefined();
    expect(refusal.refusedKinds()).toEqual([]);
    expect(refusal.originalError()).toBe("400 Unsupported parameter: 'temperature'");
  });

  it("keeps the first error when a statusless failure is refused statusless again", () => {
    const { refusal, send, end, settle, fail } = harness("openai-codex-responses");
    fail(responsesImage, "Codex error: invalid_request_error");
    send(responsesImage);
    end("error", "Codex error: invalid_request_error");
    expect(settle()).toBeUndefined();
    expect(refusal.originalError()).toBe("Codex error: invalid_request_error");
  });

  it("reports the replay's own error when it fails in another category", () => {
    const { refusal, send, end, settle, fail } = harness();
    fail(withImage, "400 Could not process image");
    send(withImage);
    end("error", "Codex error: invalid_request_error");
    expect(settle()).toBeUndefined();
    expect(refusal.originalError()).toBeUndefined();
  });

  it("forgets the chain when a stop lands during the replay", () => {
    const { refusal, send, end, settle, fail } = harness();
    fail(withImage, "400 Could not process image");
    send(withImage);
    end("aborted");
    expect(settle("aborted")).toBeUndefined();
    expect(refusal.refusedKinds()).toEqual([]);
    expect(refusal.originalError()).toBeUndefined();
  });
});

describe("a request carrying an image and a PDF", () => {
  it("withholds the PDF alone first, and names only it when that replay succeeds", () => {
    const { refusal, send, end, fail } = harness();
    expect(fail(withBoth, "400 Could not process the document")).toBe(true);
    const replayed = JSON.stringify(send(withBoth));
    expect(replayed).toContain("AAAA");
    expect(replayed).not.toContain("BBBB");
    expect(replayed).toContain(PDF_POINTER);
    end("stop");
    expect(refusal.refusedKinds()).toEqual(["pdf"]);
  });

  it("then withholds both when the PDF-less replay is refused too, at most twice", () => {
    const { refusal, send, end, settle, fail, replays } = harness();
    fail(withBoth, "400 Could not process image");
    send(withBoth);
    end("error", "400 Could not process image");
    expect(settle()).toEqual(REPLAY);
    const replayed = JSON.stringify(send(withBoth));
    expect(replayed).not.toContain("AAAA");
    expect(replayed).not.toContain("BBBB");
    end("stop");
    expect(refusal.refusedKinds().sort()).toEqual(["image", "pdf"]);
    expect(replays()).toBe(2);
  });

  it("stops after the second replay and keeps the first error", () => {
    const { refusal, send, end, settle, fail } = harness();
    fail(withBoth, "400 first");
    send(withBoth);
    end("error", "400 second");
    settle();
    send(withBoth);
    end("error", "400 third");
    expect(settle()).toBeUndefined();
    expect(refusal.refusedKinds()).toEqual([]);
    expect(refusal.originalError()).toBe("400 first");
  });
});
