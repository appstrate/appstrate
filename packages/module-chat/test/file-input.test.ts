// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { acceptsFileInput, fileDelivery, piInputModalities } from "../src/file-input.ts";

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
    });
    expect(fileDelivery({ api: "mistral-conversations", input: ["text"] })).toEqual({
      image: false,
      pdf: false,
    });
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
