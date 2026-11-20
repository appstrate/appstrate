// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { PDF_WIRE_APIS, fileDelivery, hasPdfWireFormat } from "../src/file-input.ts";

const VISION = ["text", "image"];
const TEXT = ["text"];

describe("fileDelivery", () => {
  it("sends an image unless the modalities are known and lack image", () => {
    for (const api of ["openai-responses", "anthropic-messages", null]) {
      expect(fileDelivery({ api, input: VISION }).image).toBe(true);
      expect(fileDelivery({ api, input: null }).image).toBe(true);
      expect(fileDelivery({ api }).image).toBe(true);
      expect(fileDelivery({ api, input: TEXT }).image).toBe(false);
    }
  });

  it("sends a PDF on an API with a wire format unless the model is declared text-only", () => {
    for (const api of PDF_WIRE_APIS) {
      expect(fileDelivery({ api, input: VISION }).pdf).toBe(true);
      expect(fileDelivery({ api, input: null }).pdf).toBe(true);
      expect(fileDelivery({ api, input: TEXT }).pdf).toBe(false);
    }
  });

  it("sends no PDF on an API without a wire format, whatever the modalities", () => {
    for (const api of ["openai-completions", "anthropic-messages", "openai-codex-responses"]) {
      expect(hasPdfWireFormat(api)).toBe(false);
      for (const input of [VISION, TEXT, null]) {
        expect(fileDelivery({ api, input }).pdf).toBe(false);
      }
    }
  });

  it("never blocks on an API shape that is not known", () => {
    expect(fileDelivery({})).toEqual({ image: true, pdf: true });
    expect(fileDelivery({ api: null, input: VISION })).toEqual({ image: true, pdf: true });
    expect(fileDelivery({ api: undefined, input: TEXT })).toEqual({ image: false, pdf: false });
  });
});
