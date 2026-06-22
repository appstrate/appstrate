// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { buildTranscriptPrompt } from "../src/transcript.ts";

const userMsg = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});
const assistantMsg = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("buildTranscriptPrompt", () => {
  it("a single user turn is sent verbatim (no transcript labels)", () => {
    expect(buildTranscriptPrompt([userMsg("salut")])).toBe("salut");
  });

  it("multi-turn threads become a labelled transcript", () => {
    const prompt = buildTranscriptPrompt([
      userMsg("bonjour"),
      assistantMsg("salut, comment puis-je aider ?"),
      userMsg("liste mes agents"),
    ]);
    expect(prompt).toBe(
      "User: bonjour\n\nAssistant: salut, comment puis-je aider ?\n\nUser: liste mes agents",
    );
  });

  it("skips messages with no text content and ignores non-text parts", () => {
    const withTool: UIMessage = {
      id: "x",
      role: "assistant",
      parts: [{ type: "step-start" } as never, { type: "text", text: "ok" }],
    };
    expect(buildTranscriptPrompt([userMsg("hi"), withTool])).toBe("User: hi\n\nAssistant: ok");
  });

  it("returns an empty string when there is no usable content", () => {
    expect(buildTranscriptPrompt([])).toBe("");
    expect(buildTranscriptPrompt([userMsg("   ")])).toBe("");
  });
});
