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

  it("skips a slot, which the page draws itself", () => {
    expect(
      documentTitle([
        { label: "Chat", href: "/chat" },
        { label: "", slot: true },
      ]),
    ).toBe("Chat · Appstrate");
  });
});
