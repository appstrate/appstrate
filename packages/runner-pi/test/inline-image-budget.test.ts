// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropOldInlineImages, inlineImageBudgetExtension } from "../src/inline-image-budget.ts";
import { createIsolatedResourceLoader } from "../src/isolated-resource-loader.ts";
import { loadPiCodingAgentSdk } from "../src/pi-sdk.ts";
import type { ExtensionAPI } from "../src/index.ts";

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Msg = { role: string; content: Block[] };

const image = (bytes: number, tag = "i"): Block => ({
  type: "image",
  data: tag.repeat(bytes),
  mimeType: "image/png",
});
const text = (t: string): Block => ({ type: "text", text: t });
const toolResult = (...content: Block[]): Msg => ({ role: "toolResult", content });
const isOmitted = (b: Block | undefined) =>
  b?.type === "text" && b.text.startsWith("[image omitted from this request");

describe("dropOldInlineImages", () => {
  it("returns undefined when there are no images", () => {
    expect(dropOldInlineImages([{ role: "user", content: [text("hi")] }], 10)).toBeUndefined();
  });

  it("returns undefined when every image fits", () => {
    expect(dropOldInlineImages([toolResult(image(4)), toolResult(image(5))], 10)).toBeUndefined();
  });

  it("replaces the older images beyond the budget and keeps the newest", () => {
    const messages: Msg[] = [
      toolResult(text("a"), image(6, "a"), text("pointer a")),
      { role: "assistant", content: [text("thinking")] },
      toolResult(image(6, "b"), text("pointer b")),
      toolResult(image(6, "c"), text("pointer c")),
    ];
    const out = dropOldInlineImages(messages, 10)!;
    expect(out).toHaveLength(4);
    expect(out[3]).toBe(messages[3]!);
    expect(out[1]).toBe(messages[1]!);
    expect(isOmitted(out[2]!.content[0])).toBe(true);
    expect(out[2]!.content[1]).toEqual(text("pointer b"));
    expect(out[0]!.content.map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(isOmitted(out[0]!.content[1])).toBe(true);
    expect(out[0]!.content[2]).toEqual(text("pointer a"));
  });

  it("drops every image older than the first one that does not fit", () => {
    const out = dropOldInlineImages(
      [toolResult(image(1)), toolResult(image(9)), toolResult(image(5))],
      10,
    )!;
    expect(isOmitted(out[1]!.content[0])).toBe(true);
    expect(isOmitted(out[0]!.content[0])).toBe(true);
    expect(out[2]!.content[0]!.type).toBe("image");
  });

  it("keeps the later image of two in one tool result and drops the earlier", () => {
    const out = dropOldInlineImages([toolResult(image(6, "a"), image(6, "b"))], 10)!;
    expect(isOmitted(out[0]!.content[0])).toBe(true);
    expect(out[0]!.content[1]).toEqual(image(6, "b"));
  });

  it("never brings back an image dropped on an earlier turn", () => {
    const messages = [toolResult(image(3)), toolResult(image(7)), toolResult(image(9))];
    const first = dropOldInlineImages(messages, 10)!;
    const second = dropOldInlineImages([...messages, toolResult(image(2))], 10)!;
    first.forEach((message, i) =>
      message.content.forEach((block, j) => {
        if (isOmitted(block)) expect(isOmitted(second[i]!.content[j])).toBe(true);
      }),
    );
    expect(first.flatMap((m) => m.content).filter(isOmitted)).toHaveLength(2);
  });

  it("keeps the newest image even when it alone exceeds the budget", () => {
    expect(dropOldInlineImages([toolResult(image(50))], 10)).toBeUndefined();
  });

  it("leaves user-message images alone", () => {
    const user: Msg = { role: "user", content: [image(50)] };
    expect(dropOldInlineImages([user, toolResult(image(8))], 10)).toBeUndefined();
  });

  it("does not mutate the input messages", () => {
    const messages = [toolResult(image(8)), toolResult(image(8))];
    const snapshot = structuredClone(messages);
    const first = messages[0]!;
    const firstContent = first.content;
    dropOldInlineImages(messages, 10);
    expect(messages).toEqual(snapshot);
    expect(messages[0]).toBe(first);
    expect(messages[0]!.content).toBe(firstContent);
  });
});

describe("inlineImageBudgetExtension", () => {
  it("registers a context handler that applies the transform", () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    inlineImageBudgetExtension(pi);
    const handler = handlers.get("context")!;
    expect(handler).toBeDefined();

    const big = 3 * 1024 * 1024;
    const result = handler({
      type: "context",
      messages: [toolResult(image(big)), toolResult(image(big))],
    }) as { messages: Msg[] };
    expect(isOmitted(result.messages[0]!.content[0])).toBe(true);
    expect(result.messages[1]!.content[0]!.type).toBe("image");

    expect(handler({ type: "context", messages: [toolResult(image(10))] })).toBeUndefined();
  });

  it("is loaded into every isolated resource loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "inline-image-budget-"));
    try {
      const sdk = await loadPiCodingAgentSdk();
      const loader = await createIsolatedResourceLoader({
        DefaultResourceLoader: sdk.DefaultResourceLoader,
        SettingsManager: sdk.SettingsManager,
        cwd: join(root, "workspace"),
        agentDir: join(root, "agent"),
        systemPrompt: "Platform prompt",
        extensionFactories: [],
        skillPaths: [],
      });
      const withContext = loader
        .getExtensions()
        .extensions.filter((ext) => ext.handlers.has("context"));
      expect(withContext).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
