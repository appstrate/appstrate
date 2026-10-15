// SPDX-License-Identifier: Apache-2.0

/** A card's title is its keyboard target: a link to the package's page. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PackageCard } = await import("../package-card.tsx");
const { render } = await import("../../test/render.tsx");

describe("a package card's title", () => {
  it("links to the package's page", () => {
    const html = render(<PackageCard id="@acme/worker" displayName="Worker" type="agent" />);
    expect(html).toMatch(/<a\b[^>]*href="\/agents\/@acme\/worker"[^>]*>Worker<\/a>/);
  });
});
