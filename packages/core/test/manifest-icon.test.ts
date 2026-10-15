// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseManifestIcon } from "../src/manifest-icon.ts";

describe("parseManifestIcon", () => {
  it("reads a lucide id as a lucide name", () => {
    expect(parseManifestIcon("lucide:calendar-clock")).toEqual({
      kind: "lucide",
      name: "calendar-clock",
    });
  });

  it("reads any other Iconify id as an iconify id", () => {
    expect(parseManifestIcon("logos:slack-icon")).toEqual({
      kind: "iconify",
      id: "logos:slack-icon",
    });
    expect(parseManifestIcon("simple-icons:googleforms")).toEqual({
      kind: "iconify",
      id: "simple-icons:googleforms",
    });
  });

  it("reads an http(s) URL or an image data URL as an URL", () => {
    expect(parseManifestIcon("https://cdn.example.com/a.png")).toEqual({
      kind: "url",
      src: "https://cdn.example.com/a.png",
    });
    expect(parseManifestIcon("data:image/png;base64,AAAA")).toEqual({
      kind: "url",
      src: "data:image/png;base64,AAAA",
    });
  });

  it("refuses what no surface can draw", () => {
    for (const value of [
      undefined,
      null,
      7,
      "",
      "bot",
      "assets/icon.png",
      "Logos:Slack",
      "a:b:c",
      "data:text/html,x",
      "🚜",
    ]) {
      expect(parseManifestIcon(value)).toBeNull();
    }
  });
});
