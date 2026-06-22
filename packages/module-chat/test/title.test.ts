// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { cleanTitle, collectStreamText } from "../src/title.ts";

/** Build a UI-message-stream-shaped Response (SSE `data:` frames). */
function streamResponse(lines: string[], init?: { ok?: boolean }): Response {
  return new Response(init?.ok === false ? null : lines.map((l) => `data: ${l}\n\n`).join(""), {
    status: init?.ok === false ? 429 : 200,
  });
}

describe("cleanTitle", () => {
  it("returns a plain title unchanged", () => {
    expect(cleanTitle("Liste de mes agents")).toBe("Liste de mes agents");
  });

  it("strips wrapping straight and typographic quotes", () => {
    expect(cleanTitle('"Mon titre"')).toBe("Mon titre");
    expect(cleanTitle("«Mon titre»")).toBe("Mon titre");
    expect(cleanTitle("'Mon titre'")).toBe("Mon titre");
  });

  it("strips surrounding whitespace and trailing punctuation", () => {
    expect(cleanTitle("  Mon titre.  ")).toBe("Mon titre");
  });

  it("trims trailing period the model adds despite the instruction", () => {
    expect(cleanTitle("Résumé de la conversation.")).toBe("Résumé de la conversation");
  });

  it("caps the length at 80 characters", () => {
    const long = "a".repeat(200);
    expect(cleanTitle(long)).toHaveLength(80);
  });

  it("an empty / whitespace-only string collapses to empty", () => {
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle('""')).toBe("");
  });
});

describe("collectStreamText", () => {
  it("concatenates only the text-delta deltas from the UI message stream", async () => {
    const res = streamResponse([
      JSON.stringify({ type: "start", messageId: "m1" }),
      JSON.stringify({ type: "start-step" }),
      JSON.stringify({ type: "text-start", id: "0" }),
      JSON.stringify({ type: "text-delta", id: "0", delta: "Liste des " }),
      JSON.stringify({ type: "text-delta", id: "0", delta: "agents" }),
      JSON.stringify({ type: "text-end", id: "0" }),
      JSON.stringify({ type: "finish" }),
    ]);
    expect(await collectStreamText(res)).toBe("Liste des agents");
  });

  it("ignores tool/error chunks and yields the assistant text only", async () => {
    const res = streamResponse([
      JSON.stringify({ type: "tool-input-start", toolCallId: "t", toolName: "x" }),
      JSON.stringify({ type: "text-delta", id: "0", delta: "Titre" }),
      JSON.stringify({ type: "error", errorText: "boom" }),
    ]);
    expect(await collectStreamText(res)).toBe("Titre");
  });

  it("returns empty for a non-OK (capacity) response", async () => {
    expect(await collectStreamText(streamResponse([], { ok: false }))).toBe("");
  });
});
