// SPDX-License-Identifier: Apache-2.0

/**
 * An agent launch: an unreachable platform is a 502, and the replay of old launches is bounded.
 * The internal-error 502 and the unknown-name 400 are covered end to end by
 * `chat-stream-handler.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import {
  AGENT_LAUNCH_REPLAY_BUDGET_CHARS,
  resolveAgentPrompt,
  withStoredAgentPromptTexts,
} from "../src/agent-launch.ts";

const launchMessage = (id: string, name = "run-report", title = "Weekly report"): UIMessage =>
  ({
    id,
    role: "user",
    parts: [
      { type: "text", text: "for Q3" },
      { type: "data-agent-prompt", data: { name, title } },
    ],
  }) as UIMessage;

const textOf = (message: UIMessage): string | undefined =>
  (message.parts.find((p) => p.type === "data-agent-prompt") as { data: { text?: string } }).data
    .text;

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  return promise.then(
    () => undefined,
    (err: { status?: number }) => err.status,
  );
}

describe("resolveAgentPrompt failures", () => {
  it("answers an unreachable platform server with a 502", async () => {
    const open = async () => {
      throw new Error("connect refused");
    };
    expect(await statusOf(resolveAgentPrompt(launchMessage("m1"), open))).toBe(502);
  });
});

describe("withStoredAgentPromptTexts replay budget", () => {
  const half = "x".repeat(AGENT_LAUNCH_REPLAY_BUDGET_CHARS / 2 + 1);

  function thread() {
    const messages = [
      launchMessage("m1", "run-old", "Old agent"),
      launchMessage("m2", "run-mid", "Mid agent"),
      launchMessage("m3", "run-new", "New agent"),
      launchMessage("m4", "run-last", "Last agent"),
    ];
    const stored = new Map([
      ["m1", half],
      ["m2", half],
      ["m3", "short launch"],
    ]);
    return { messages, stored };
  }

  it("keeps the most recent launches in full and stubs the older ones", () => {
    const { messages, stored } = thread();
    const out = withStoredAgentPromptTexts(messages, stored);
    expect(textOf(out[2]!)).toBe("short launch");
    expect(textOf(out[1]!)).toBe(half);
    const stub = textOf(out[0]!)!;
    expect(stub.length).toBeLessThan(400);
    expect(stub).toContain("Old agent");
    expect(stub).toContain("run-old");
    expect(stub).toContain("dropped");
    expect(textOf(out[3]!)).toBeUndefined();
  });

  it("bounds the total replayed text", () => {
    const messages = Array.from({ length: 20 }, (_, i) => launchMessage(`m${i}`));
    messages.push(launchMessage("last"));
    const stored = new Map(messages.map((m) => [m.id, "y".repeat(20_000)]));
    const out = withStoredAgentPromptTexts(messages, stored);
    const total = out.reduce((sum, m) => sum + (textOf(m)?.length ?? 0), 0);
    const full = out.filter((m) => textOf(m)?.length === 20_000).length;
    expect(full).toBe(3);
    expect(total).toBeLessThan(AGENT_LAUNCH_REPLAY_BUDGET_CHARS + 20 * 400);
  });
});
