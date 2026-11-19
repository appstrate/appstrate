// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";

it("lets the keyboard resize the layout and preserves pinch zoom", async () => {
  const html = await Bun.file(new URL("../../../index.html", import.meta.url)).text();
  const meta = html.match(/<meta\s+name="viewport"[^>]*>/)?.[0] ?? "";
  expect(meta).toContain("interactive-widget=resizes-content");
  expect(meta).not.toContain("maximum-scale");
  expect(meta).not.toContain("user-scalable");
});
