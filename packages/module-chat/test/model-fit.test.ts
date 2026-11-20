// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import { derivePiCompactionSettings } from "@appstrate/runner-pi";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "@appstrate/core/token-budget";
import {
  IMAGE_TOKENS,
  PDF_BYTES_PER_TOKEN,
  PDF_TURN_MAX_BYTES,
  draftCrossesThreshold,
  estimateDraftTokens,
  modelFit,
  modelSizing,
  selectedModelReading,
} from "../src/ui/model-fit.ts";
import { contextReading, type ConversationContext } from "../src/ui/turn-context.ts";

function measured(tokens: number, window = 200_000, compactAt = 136_000): ConversationContext {
  const base = { tokens, window, compactAt };
  return {
    ...base,
    ...contextReading(base),
    summarized: false,
    modelId: "measuring",
    modelLabel: "Claude",
  };
}

describe("modelSizing", () => {
  it("mirrors the engine's PDF cap", () => {
    expect(PDF_TURN_MAX_BYTES).toBe(RESOURCE_BLOB_MAX_BYTES);
  });

  it("gives the threshold the engine computes, defaults included", () => {
    const rows = [
      { contextWindow: 200_000, maxTokens: 64_000 },
      { contextWindow: 1_000_000, maxTokens: 384_000 },
      { contextWindow: 32_000, maxTokens: null },
      { contextWindow: null, maxTokens: null },
      { contextWindow: 100_000, maxTokens: 100_000 },
    ];
    for (const row of rows) {
      // The engine sizes `buildPiModel`'s output, which fills both defaults.
      const engine = derivePiCompactionSettings({
        contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: row.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
      expect(modelSizing(row)).toEqual({
        window: engine.contextWindow,
        compactAt: engine.contextWindow - engine.compaction.reserveTokens,
        ...(row.contextWindow === null ? { windowAssumed: true } : {}),
      });
    }
  });

  it("marks only a row that declares no window as assumed", () => {
    expect(modelSizing({ contextWindow: null })?.windowAssumed).toBe(true);
    expect(modelSizing({ contextWindow: 200_000 })).not.toHaveProperty("windowAssumed");
  });

  it("knows nothing of an alias", () => {
    expect(modelSizing({ aliased: true, contextWindow: null, maxTokens: null })).toBeNull();
  });
});

describe("selectedModelReading", () => {
  const small = { window: 128_000, compactAt: 111_616 };

  it("keeps the measure when the selected model measured it", () => {
    const context = measured(120_000);
    expect(selectedModelReading(context, "measuring", small)).toEqual({
      context,
      measuredWith: null,
      readAgainstSelected: false,
    });
  });

  it("reads the measure against another selected model's sizing", () => {
    const reading = selectedModelReading(measured(120_000), "other", small);
    expect(reading.readAgainstSelected).toBe(true);
    expect(reading.measuredWith).toBe("Claude");
    expect(reading.context).toMatchObject({ tokens: 120_000, ...small, level: "full", ratio: 1 });
  });

  it("takes the selected model's assumption, not the measuring one's", () => {
    const assumedMeasure = { ...measured(120_000), windowAssumed: true as const };
    expect(selectedModelReading(assumedMeasure, "other", small).context).not.toHaveProperty(
      "windowAssumed",
    );
    const assumed = { ...small, windowAssumed: true as const };
    expect(selectedModelReading(measured(120_000), "other", assumed).context.windowAssumed).toBe(
      true,
    );
  });

  it("keeps the measure, naming its model, when the selected one's sizing is unknown", () => {
    const context = measured(120_000);
    expect(selectedModelReading(context, "alias", null)).toEqual({
      context,
      measuredWith: "Claude",
      readAgainstSelected: false,
    });
  });
});

describe("modelFit", () => {
  const sizing = { window: 128_000, compactAt: 100_000 };

  it("flags only past the margin", () => {
    expect(modelFit(119_000, sizing)).toBeNull();
    expect(modelFit(121_000, sizing)).toBe("threshold");
    expect(modelFit(150_000, sizing)).toBe("threshold");
    expect(modelFit(155_000, sizing)).toBe("window");
  });

  it("never says an assumed window exceeded, only its threshold", () => {
    const assumed = { ...sizing, windowAssumed: true as const };
    expect(modelFit(155_000, assumed)).toBe("threshold");
    expect(modelFit(119_000, assumed)).toBeNull();
  });

  it("says nothing without a sizing", () => {
    expect(modelFit(1_000_000, null)).toBeNull();
  });
});

describe("estimateDraftTokens", () => {
  const sees = { readsImages: true, readsPdf: true };
  const pointer = (name: string) => Math.ceil((name.length + 80) / 4);

  it("counts a text file as its pointer line only", () => {
    const file = { name: "notes.txt", mime: "text/plain", size: 400_000 };
    expect(estimateDraftTokens([file], sees)).toBe(pointer("notes.txt"));
  });

  it("counts an image's pixels only for a model that reads images, four at most", () => {
    const image = { name: "a.png", mime: "image/png", size: 1 };
    expect(estimateDraftTokens([image], sees)).toBe(pointer("a.png") + IMAGE_TOKENS);
    expect(estimateDraftTokens([image], { readsImages: null, readsPdf: true })).toBe(
      pointer("a.png"),
    );
    expect(estimateDraftTokens(Array(5).fill(image), sees)).toBe(
      5 * pointer("a.png") + 4 * IMAGE_TOKENS,
    );
  });

  it("counts PDFs the turn would send, within its byte cap", () => {
    const pdf = (size: number) => ({ name: "r.pdf", mime: "application/pdf", size });
    expect(estimateDraftTokens([pdf(64_000)], sees)).toBe(
      pointer("r.pdf") + 64_000 / PDF_BYTES_PER_TOKEN,
    );
    expect(estimateDraftTokens([pdf(64_000)], { readsImages: true, readsPdf: false })).toBe(
      pointer("r.pdf"),
    );
    // Over the cap the engine omits it; the next one still fits.
    expect(estimateDraftTokens([pdf(PDF_TURN_MAX_BYTES + 1), pdf(6_400)], sees)).toBe(
      2 * pointer("r.pdf") + 100,
    );
  });
});

describe("draftCrossesThreshold", () => {
  it("warns only when the draft takes a conversation under the threshold past it", () => {
    expect(draftCrossesThreshold({ tokens: 90_000, compactAt: 100_000 }, 5_000)).toBe(false);
    expect(draftCrossesThreshold({ tokens: 96_000, compactAt: 100_000 }, 5_000)).toBe(true);
    // Already past: the gauge says it.
    expect(draftCrossesThreshold({ tokens: 101_000, compactAt: 100_000 }, 5_000)).toBe(false);
  });
});
