// SPDX-License-Identifier: Apache-2.0

/** A card's title is its keyboard target: a link to the page, or a button opening it in place. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PackageCard } = await import("../package-card.tsx");
const { render } = await import("../../test/render.tsx");

describe("a package card's title", () => {
  it("links to the package's page", () => {
    const html = render(<PackageCard id="@acme/notes" displayName="Notes" type="skill" />);
    expect(html).toMatch(/<a\b[^>]*href="\/skills\/@acme\/notes"[^>]*>Notes<\/a>/);
    expect(html).not.toContain("<button");
  });

  it("is a button, and no link, when the card opens in place", () => {
    const html = render(
      <PackageCard id="@acme/notes" displayName="Notes" type="skill" onOpen={() => {}} />,
    );
    expect(html).toMatch(/<button\b[^>]*type="button"[^>]*>Notes<\/button>/);
    expect(html).not.toContain("<a ");
  });
});
