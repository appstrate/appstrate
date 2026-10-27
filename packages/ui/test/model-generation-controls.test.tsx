// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelGenerationControls } from "../src/components/model-generation-controls.tsx";
import { buildGenerationLabels } from "../src/components/model-generation-labels.ts";
import type { ModelGenerationCapabilities } from "@appstrate/core/model-generation";

const capabilities: ModelGenerationCapabilities = {
  temperature: "supported",
  reasoning: {
    supported: "supported",
    adaptive: null,
    levels: { off: "supported", high: "supported" },
  },
};
const labels = buildGenerationLabels((key) => key);
const render = (temperature?: number) =>
  renderToStaticMarkup(
    <ModelGenerationControls
      value={{ temperature, reasoning_level: "high" }}
      capabilities={capabilities}
      labels={labels}
      onChange={() => {}}
    />,
  );

describe("shared generation controls", () => {
  it("keeps zero distinct from inheritance and does not round a stored temperature", () => {
    expect(render(0)).toContain(">0</span>");
    expect(render(0.37)).toContain("0.37");
    expect(render()).toContain("models.generation.inherit");
  });

  it("names both controls and connects each description to its control", () => {
    const html = render();
    const ids = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`aria-describedby="${id}-hint"`);
    }
  });
});
