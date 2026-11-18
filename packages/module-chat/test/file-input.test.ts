// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  acceptsFileInput,
  fileDelivery,
  piInputModalities,
  refusedFileKinds,
} from "../src/file-input.ts";

describe("acceptsFileInput", () => {
  it("refuses an image only when the modalities are known and lack it", () => {
    expect(acceptsFileInput({ api: "openai-completions", input: null }, "image")).toBe(true);
    expect(acceptsFileInput({ api: "openai-completions", input: undefined }, "image")).toBe(true);
    expect(acceptsFileInput({ api: "openai-completions", input: ["text", "image"] }, "image")).toBe(
      true,
    );
    expect(acceptsFileInput({ api: "openai-completions", input: ["text"] }, "image")).toBe(false);
  });

  it("sends a PDF on an API shape with a wire format for it, unless declared text-only", () => {
    for (const api of [
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "openai-completions",
    ]) {
      expect(acceptsFileInput({ api, input: ["text", "image"] }, "pdf")).toBe(true);
      expect(acceptsFileInput({ api, input: null }, "pdf")).toBe(true);
      // Providers read PDF pages as images.
      expect(acceptsFileInput({ api, input: ["text"] }, "pdf")).toBe(false);
    }
    expect(
      acceptsFileInput({ api: "mistral-conversations", input: ["text", "image"] }, "pdf"),
    ).toBe(false);
    expect(acceptsFileInput({ api: null, input: ["text", "image"] }, "pdf")).toBeNull();
    expect(acceptsFileInput({ api: undefined, input: null }, "pdf")).toBeNull();
    expect(acceptsFileInput({ api: null, input: ["text"] }, "pdf")).toBe(false);
  });
});

describe("fileDelivery", () => {
  it("sends what is not declared impossible", () => {
    expect(fileDelivery({ api: "openai-responses", input: null })).toEqual({
      image: true,
      pdf: true,
      refused: [],
    });
    expect(fileDelivery({ api: "mistral-conversations", input: ["text"] })).toEqual({
      image: false,
      pdf: false,
      refused: [],
    });
  });

  it("withholds only the kinds the model refused", () => {
    const model = { api: "openai-responses", input: null };
    expect(fileDelivery(model, { refused: ["image"] })).toEqual({
      image: false,
      pdf: true,
      refused: ["image"],
    });
    expect(fileDelivery(model, { refused: ["pdf"] })).toEqual({
      image: true,
      pdf: false,
      refused: ["pdf"],
    });
  });
});

describe("refusedFileKinds", () => {
  const turn = (modelId: string, refused?: string[]) => ({
    role: "assistant",
    metadata: {
      appstrate: {
        turn: {
          finishReason: "stop",
          modelId,
          ...(refused ? { refusedFileKinds: refused } : {}),
          stepCount: 2,
          maxSteps: 16,
          maxStepsReached: false,
        },
      },
    },
  });
  const user = { role: "user", parts: [] };

  it("collects the preset's refused kinds for the rest of the thread", () => {
    const thread = [user, turn("preset-a", ["image"]), user, turn("preset-a", ["pdf"]), user];
    expect(refusedFileKinds(thread, "preset-a").sort()).toEqual(["image", "pdf"]);
  });

  it("is empty for another preset, and without a recorded refusal", () => {
    const thread = [user, turn("preset-a", ["image"])];
    expect(refusedFileKinds(thread, "preset-b")).toEqual([]);
    expect(refusedFileKinds([user, turn("preset-a")], "preset-a")).toEqual([]);
    expect(refusedFileKinds([user], "preset-a")).toEqual([]);
  });
});

describe("piInputModalities", () => {
  it("widens unknown modalities to text and image, and copies known ones", () => {
    expect(piInputModalities(null)).toEqual(["text", "image"]);
    expect(piInputModalities(undefined)).toEqual(["text", "image"]);
    const declared = ["text"] as const;
    const out = piInputModalities(declared);
    expect(out).toEqual(["text"]);
    expect(out).not.toBe(declared);
  });
});
