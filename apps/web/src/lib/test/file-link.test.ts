// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  fileContextHeader,
  fileReaderPath,
  fileReaderUrl,
  otherSpaceFileContext,
  readerContext,
} from "../file-link.ts";

const CONTEXT = { orgId: "org_1", spaceId: "spc_1" };

describe("reader link", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });

  it("names the file, its organization and its space", () => {
    expect(fileReaderPath("file_1", CONTEXT)).toBe("/files/file_1?org=org_1&space=spc_1");
  });

  it("is absolute on the app's origin when copied", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://app.example" } },
    });
    expect(fileReaderUrl("file_1", CONTEXT)).toBe(
      "https://app.example/files/file_1?org=org_1&space=spc_1",
    );
  });

  it("reads back the context it wrote", () => {
    const [, query] = fileReaderPath("file_1", CONTEXT).split("?");
    expect(readerContext(new URLSearchParams(query))).toEqual(CONTEXT);
  });

  it("names no context unless both halves are there", () => {
    expect(readerContext(new URLSearchParams(""))).toBeUndefined();
    expect(readerContext(new URLSearchParams("org=org_1"))).toBeUndefined();
    expect(readerContext(new URLSearchParams("space=spc_1"))).toBeUndefined();
    expect(readerContext(new URLSearchParams("org=&space=spc_1"))).toBeUndefined();
  });

  it("reads a file of another space in its own, never one of the current space", () => {
    expect(otherSpaceFileContext("spc_2", "org_1", "spc_1")).toEqual({
      orgId: "org_1",
      spaceId: "spc_2",
    });
    expect(otherSpaceFileContext("spc_1", "org_1", "spc_1")).toBeUndefined();
    // No current space yet, no org yet, or no space on the row: nothing to read elsewhere.
    expect(otherSpaceFileContext("spc_2", "org_1", null)).toBeUndefined();
    expect(otherSpaceFileContext("spc_2", null, "spc_1")).toBeUndefined();
    expect(otherSpaceFileContext(undefined, "org_1", "spc_1")).toBeUndefined();
  });

  it("sends the context as the scoping headers, and nothing without one", () => {
    expect(fileContextHeader(CONTEXT)).toEqual({ "X-Org-Id": "org_1", "X-Space-Id": "spc_1" });
    expect(fileContextHeader(undefined)).toBeUndefined();
  });
});
