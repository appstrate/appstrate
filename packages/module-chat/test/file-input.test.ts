// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  acceptsFileInput,
  fileDelivery,
  fileInputRefused,
  piInputModalities,
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

  it("sends a PDF on an API shape with a wire format for it, whatever the modalities", () => {
    for (const api of [
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "openai-completions",
    ]) {
      expect(acceptsFileInput({ api, input: ["text"] }, "pdf")).toBe(true);
      expect(acceptsFileInput({ api, input: null }, "pdf")).toBe(true);
    }
    expect(
      acceptsFileInput({ api: "mistral-conversations", input: ["text", "image"] }, "pdf"),
    ).toBe(false);
    expect(acceptsFileInput({ api: null, input: ["text", "image"] }, "pdf")).toBeNull();
    expect(acceptsFileInput({ api: undefined, input: null }, "pdf")).toBeNull();
  });
});

describe("fileDelivery", () => {
  it("sends what is not declared impossible", () => {
    expect(fileDelivery({ api: "openai-responses", input: null })).toEqual({
      image: true,
      pdf: true,
      refused: false,
    });
    expect(fileDelivery({ api: "mistral-conversations", input: ["text"] })).toEqual({
      image: false,
      pdf: false,
      refused: false,
    });
  });

  it("sends no file at all once the model refused one", () => {
    expect(fileDelivery({ api: "openai-responses", input: null }, { refused: true })).toEqual({
      image: false,
      pdf: false,
      refused: true,
    });
  });
});

describe("fileInputRefused", () => {
  const failed = (modelId: string, errorReason?: string) => ({
    role: "assistant",
    metadata: {
      appstrate: {
        turn: {
          finishReason: "error",
          errorCategory: "invalid_request",
          ...(errorReason ? { errorReason } : {}),
          modelId,
          stepCount: 1,
          maxSteps: 16,
          maxStepsReached: false,
        },
      },
    },
  });
  const user = { role: "user", parts: [] };

  it("holds for the preset that refused, for the rest of the thread", () => {
    expect(
      fileInputRefused([user, failed("preset-a", "file_input_refused"), user], "preset-a"),
    ).toBe(true);
  });

  it("does not hold for another preset, nor without the marker", () => {
    const thread = [user, failed("preset-a", "file_input_refused")];
    expect(fileInputRefused(thread, "preset-b")).toBe(false);
    expect(fileInputRefused([user, failed("preset-a")], "preset-a")).toBe(false);
    expect(fileInputRefused([user], "preset-a")).toBe(false);
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
