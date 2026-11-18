// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { callSpaceOf, fileSpaceOf } from "../src/ui/conversation-scope.ts";

describe("callSpaceOf", () => {
  it("reads the stamp the engine put on the call", () => {
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: "spc_a" } } })).toBe("spc_a");
  });

  it("never reads the space the call's arguments name", () => {
    const named = { args: { operation_id: "x", space_id: "spc_b" } };
    expect(callSpaceOf(named)).toBeUndefined();
    expect(callSpaceOf({ ...named, providerMetadata: {} })).toBeUndefined();
    expect(
      callSpaceOf({ ...named, providerMetadata: { appstrate: { spaceId: "spc_origin" } } }),
    ).toBe("spc_origin");
  });

  it("is undefined without a usable stamp", () => {
    expect(callSpaceOf({})).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: {} } })).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: "" } } })).toBeUndefined();
  });
});

describe("fileSpaceOf (where a file the answer links to lives)", () => {
  const stamp = (spaceId: string) => ({ providerMetadata: { appstrate: { spaceId } } });

  it("reads the space of the part that brought the file in: import, attachment, read", () => {
    const messages = [
      {
        content: [],
        attachments: [
          { content: [{ type: "image", image: "appfile://file_attach01", ...stamp("spc_a") }] },
        ],
      },
      {
        content: [
          { type: "tool-call", args: { uri: "appfile://file_reading1" }, ...stamp("spc_b") },
          { type: "file", data: "appfile://file_import01", ...stamp("spc_c") },
        ],
      },
    ];
    expect(fileSpaceOf(messages, "file_attach01")).toBe("spc_a");
    expect(fileSpaceOf(messages, "file_reading1")).toBe("spc_b");
    expect(fileSpaceOf(messages, "file_import01")).toBe("spc_c");
  });

  it("is undefined for a file no part names, or a part without a stamp", () => {
    const messages = [{ content: [{ type: "file", data: "appfile://file_xxxxxxxx" }] }];
    expect(fileSpaceOf(messages, "file_xxxxxxxx")).toBeUndefined();
    expect(fileSpaceOf(messages, "file_another1")).toBeUndefined();
  });
});
