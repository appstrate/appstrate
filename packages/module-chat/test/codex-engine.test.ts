// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { CodexUiStreamMapper } from "../src/codex-agent/ui-stream-mapper.ts";
import { buildTranscriptPrompt } from "../src/transcript.ts";
import type { UIMessage } from "ai";

describe("CodexUiStreamMapper", () => {
  it("maps a turn to start-step → text block → finish-step with usage", () => {
    const m = new CodexUiStreamMapper();
    expect(m.map({ type: "thread.started", thread_id: "t1" })).toEqual([]);
    expect(m.map({ type: "turn.started" })).toEqual([{ type: "start-step" }]);
    expect(
      m.map({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "hello" } }),
    ).toEqual([
      { type: "text-start", id: "i0" },
      { type: "text-delta", id: "i0", delta: "hello" },
      { type: "text-end", id: "i0" },
    ]);
    expect(
      m.map({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
    ).toEqual([{ type: "finish-step" }]);
    const finish = m.finishChunk();
    expect(finish.type).toBe("finish");
    expect(m.resultMeta()?.usage?.output_tokens).toBe(5);
  });

  it("maps a reasoning item to a reasoning block", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({ type: "item.completed", item: { id: "r0", type: "reasoning", text: "thinking" } }),
    ).toEqual([
      { type: "reasoning-start", id: "r0" },
      { type: "reasoning-delta", id: "r0", delta: "thinking" },
      { type: "reasoning-end", id: "r0" },
    ]);
  });

  it("skips codex coding-sandbox items (command_execution etc.)", () => {
    const m = new CodexUiStreamMapper();
    expect(
      m.map({ type: "item.completed", item: { id: "c0", type: "command_execution", text: "ls" } }),
    ).toEqual([]);
  });

  it("surfaces a turn.failed as an error chunk + error meta", () => {
    const m = new CodexUiStreamMapper();
    const out = m.map({ type: "turn.failed", error: { message: "boom" } });
    expect(out).toEqual([{ type: "error", errorText: "boom" }]);
    expect(m.resultMeta()?.isError).toBe(true);
    expect(m.finishChunk().finishReason).toBe("error");
  });
});

describe("buildTranscriptPrompt (codex system prefix)", () => {
  const mk = (role: "user" | "assistant", text: string): UIMessage =>
    ({ id: role, role, parts: [{ type: "text", text }] }) as UIMessage;

  it("a single user turn is sent verbatim under the system prefix", () => {
    const out = buildTranscriptPrompt([mk("user", "salut")], { system: "SYS" });
    expect(out).toBe("SYS\n\n---\n\nsalut");
  });

  it("multiple turns become a labelled transcript", () => {
    const out = buildTranscriptPrompt([mk("user", "a"), mk("assistant", "b"), mk("user", "c")], {
      system: "",
    });
    expect(out).toBe("User: a\n\nAssistant: b\n\nUser: c");
  });
});
