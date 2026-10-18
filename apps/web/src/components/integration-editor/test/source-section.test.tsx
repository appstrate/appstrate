// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { SourceSection } from "../source-section.tsx";

await i18nReady;

describe("SourceSection", () => {
  it("renders no analyse control: typing a URL is a plain config edit", () => {
    const remote = { source: { kind: "remote", remote: { url: "https://x.test/mcp" } } };
    const html = render(<SourceSection manifest={remote} onChange={() => {}} />);
    expect(html).toContain("https://x.test/mcp");
    expect(html).not.toContain("integration-editor-analyse");
    expect(html).not.toContain("Analyser");
  });
});
