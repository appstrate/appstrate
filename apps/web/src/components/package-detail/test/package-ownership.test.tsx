// SPDX-License-Identifier: Apache-2.0

/**
 * The ownership notice depends on the package detail (source, origin, draft).
 * While that read is on its way its place is held by a skeleton, so the notice
 * does not pop in above the panel once `source` turns out to be « system ».
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { PackageOwnershipNotice } from "../package-ownership.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const notice = (props: { isOwned: boolean; pending?: boolean }) =>
  render(
    <PackageOwnershipNotice
      type="integration"
      forkedFrom={null}
      draftReadOnly={false}
      {...props}
    />,
  );

describe("PackageOwnershipNotice", () => {
  it("holds its place with a skeleton while the package detail loads", () => {
    expect(notice({ isOwned: true, pending: true })).toContain("animate-pulse");
  });

  it("draws nothing for an owned package once known", () => {
    expect(notice({ isOwned: true })).toBe("");
  });

  it("says a system package is read-only once known", () => {
    const html = notice({ isOwned: false });
    expect(html).toContain("en lecture seule");
    expect(html).not.toContain("animate-pulse");
  });
});
