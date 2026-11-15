// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { documentTitle } from "../use-document-title.ts";

describe("documentTitle", () => {
  it("names the app alone when no page published a trail", () => {
    expect(documentTitle([])).toBe("Appstrate");
  });

  it("is the last crumb, the place the reader is in", () => {
    expect(documentTitle([{ label: "Agents", href: "/agents" }, { label: "Mail triage" }])).toBe(
      "Mail triage · Appstrate",
    );
  });

  it("skips a slot still loading, then names it once it carries its label", () => {
    expect(
      documentTitle([
        { label: "Chat", href: "/chat" },
        { label: "", slot: true },
      ]),
    ).toBe("Chat · Appstrate");
    expect(
      documentTitle([
        { label: "Chat", href: "/chat" },
        { label: "Bilan du trimestre", slot: true },
      ]),
    ).toBe("Bilan du trimestre · Appstrate");
  });
});
