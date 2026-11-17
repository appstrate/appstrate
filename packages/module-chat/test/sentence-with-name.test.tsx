// SPDX-License-Identifier: Apache-2.0

/** The sentence helpers: one inline wrapper, so a flex parent cannot drop the spaces around the name. */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sentenceWithName, sentenceWithNode } from "../src/ui/sentence-with-name.tsx";

const t = (key: string, options?: Record<string, unknown>) =>
  key === "limit" ? `Limiter à ${options?.name}` : `${options?.name} limitée`;

describe("sentenceWithNode", () => {
  it("keeps the space before the node inside one inline wrapper", () => {
    const html = renderToStaticMarkup(
      <div className="flex">{sentenceWithNode(t, "limit", <b>Studio</b>)}</div>,
    );
    expect(html).toBe(
      '<div class="flex"><span>Limiter à <span class="inline-flex max-w-full align-middle"><b>Studio</b></span></span></div>',
    );
  });

  it("keeps the space after the node", () => {
    const html = renderToStaticMarkup(
      <div className="flex">
        {sentenceWithNode((_k, o) => `${o?.name} limitée`, "x", <b>S</b>)}
      </div>,
    );
    expect(html).toContain(
      '<span><span class="inline-flex max-w-full align-middle"><b>S</b></span> limitée</span>',
    );
  });
});

describe("sentenceWithName", () => {
  it("keeps the space before the bold name inside one wrapper", () => {
    const html = renderToStaticMarkup(<div>{sentenceWithName(t, "limit", "Studio")}</div>);
    expect(html).toBe('<div><span>Limiter à <span class="font-medium">Studio</span></span></div>');
  });
});
