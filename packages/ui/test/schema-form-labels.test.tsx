// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SchemaForm } from "../src/schema-form/index.tsx";

const WRAPPER = {
  schema: {
    type: "object" as const,
    properties: { tags: { type: "array" as const, items: { type: "string" as const } } },
  },
};

function render(labels?: { addItem: string; removeItem: string }): string {
  return renderToStaticMarkup(
    <SchemaForm wrapper={WRAPPER} formData={{ tags: ["a"] }} labels={labels} />,
  );
}

describe("SchemaForm array chrome", () => {
  it("renders the host's labels on the item buttons", () => {
    const html = render({ addItem: "Ajouter", removeItem: "Retirer" });
    expect(html).toContain('aria-label="Retirer"');
    expect(html).toContain("Ajouter");
    expect(html).not.toContain('aria-label="Remove"');
  });

  it("falls back to English without labels", () => {
    expect(render()).toContain('aria-label="Remove"');
  });
});
