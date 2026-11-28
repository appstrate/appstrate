// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { CREDENTIAL_DEATH_CAUSES } from "@appstrate/core/sidecar-types";

const DOC = new URL("../../../../docs/site/features/webhooks.mdx", import.meta.url);

describe("credential.needs_reconnection causes in the webhooks page", () => {
  it("lists every cause the platform can send, and no other", async () => {
    const text = await Bun.file(DOC).text();
    const table = text.slice(text.indexOf("`cause` is one of:")).split("\n\n")[1] ?? "";
    const listed = [
      ...table
        .split("\n")
        .slice(2)
        .join("\n")
        .matchAll(/^\| `([a-z_]+)` +\|/gm),
    ].map((m) => m[1]);
    expect(listed.sort()).toEqual([...CREDENTIAL_DEATH_CAUSES].sort());
  });
});
