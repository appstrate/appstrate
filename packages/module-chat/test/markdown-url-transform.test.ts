// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { urlTransform } from "../src/ui/markdown-url.ts";

describe("markdown urlTransform", () => {
  it("lets a platform file URI through, which react-markdown would drop", () => {
    expect(urlTransform("appfile://file_abc12345")).toBe("appfile://file_abc12345");
  });

  it("drops a malformed file URI like any unknown protocol", () => {
    expect(urlTransform("appfile://../etc/passwd")).toBe("");
    expect(urlTransform("appfile://file_")).toBe("");
  });

  it("keeps react-markdown's own rule for everything else", () => {
    expect(urlTransform("https://example.com/a?b=c:d")).toBe("https://example.com/a?b=c:d");
    expect(urlTransform("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(urlTransform("/relative/path")).toBe("/relative/path");
    expect(urlTransform("javascript:alert(1)")).toBe("");
    expect(urlTransform("data:text/html,<script>")).toBe("");
  });
});
