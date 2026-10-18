// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { i18nReady } from "../../i18n.ts";
import { EditorSkeleton } from "../monaco";
import { render } from "../../test/render.tsx";

await i18nReady;

describe("EditorSkeleton", () => {
  it("is the editor's own box, text lines and no spinner", () => {
    const html = render(<EditorSkeleton height="520px" />);
    expect(html).toContain("height:520px");
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("animate-spin");
  });
});
