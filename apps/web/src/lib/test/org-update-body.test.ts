// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { orgUpdateBody } from "../org-update-body.ts";

describe("orgUpdateBody", () => {
  it("renames with the name alone", () => {
    expect(orgUpdateBody({ field: "name", value: "Acme" })).toEqual({ name: "Acme" });
  });

  it("sends the icon alone, in any form the organization takes, null clearing it", () => {
    expect(orgUpdateBody({ field: "icon", value: "lucide:rocket" })).toEqual({
      icon: "lucide:rocket",
    });
    expect(orgUpdateBody({ field: "icon", value: "emoji:🧠" })).toEqual({ icon: "emoji:🧠" });
    expect(orgUpdateBody({ field: "icon", value: "data:image/webp;base64,UklGRg==" })).toEqual({
      icon: "data:image/webp;base64,UklGRg==",
    });
    expect(orgUpdateBody({ field: "icon", value: null })).toEqual({ icon: null });
  });

  it("sends the colour alone, null going back to the one derived from the id", () => {
    expect(orgUpdateBody({ field: "color", value: "emerald" })).toEqual({ color: "emerald" });
    expect(orgUpdateBody({ field: "color", value: null })).toEqual({ color: null });
  });
});
