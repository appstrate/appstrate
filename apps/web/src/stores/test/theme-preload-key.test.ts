// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { LOCAL_STORAGE_KEYS, storageKey } from "@appstrate/ui/local-storage";

const INDEX_HTML = new URL("../../../index.html", import.meta.url);

describe("index.html pre-paint theme script", () => {
  it("reads the key the theme store writes", async () => {
    const html = await Bun.file(INDEX_HTML).text();
    const read = /localStorage\.getItem\("([^"]+)"\)/.exec(html)?.[1];
    expect(read).toBe(storageKey(LOCAL_STORAGE_KEYS.theme));
  });
});
