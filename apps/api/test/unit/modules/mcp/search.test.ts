// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { rankByKeywords } from "../../../../src/modules/mcp/search.ts";

const fields = (item: { name: string; text: string }) => item;
const names = (ranked: { item: { name: string } }[]) => ranked.map(({ item }) => item.name);

describe("rankByKeywords", () => {
  const listedBySpace = [
    { name: "@z/report", text: "space-b" },
    { name: "@a/report", text: "space-b" },
    { name: "@m/report", text: "space-a" },
  ];

  it("orders equal scores by name, whatever order the spaces listed them in", () => {
    expect(names(rankByKeywords(listedBySpace, [], fields))).toEqual([
      "@a/report",
      "@m/report",
      "@z/report",
    ]);
    expect(names(rankByKeywords(listedBySpace.toReversed(), ["report"], fields))).toEqual([
      "@a/report",
      "@m/report",
      "@z/report",
    ]);
  });

  it("orders equal names by text", () => {
    const tools = [
      { name: "send", text: "@b/mail" },
      { name: "send", text: "@a/mail" },
    ];
    expect(rankByKeywords(tools, ["send"], fields).map(({ item }) => item.text)).toEqual([
      "@a/mail",
      "@b/mail",
    ]);
  });

  it("keeps the score ahead of the name", () => {
    const items = [
      { name: "@a/other", text: "mentions report" },
      { name: "@z/report", text: "" },
    ];
    expect(names(rankByKeywords(items, ["report"], fields))).toEqual(["@z/report", "@a/other"]);
  });
});
