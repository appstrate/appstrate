// SPDX-License-Identifier: Apache-2.0

/** The trail's conversation name survives a list filter that does not hold the open conversation. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { resolveCrumbTitle } = await import("./chat-crumb-title.ts");

describe("resolveCrumbTitle", () => {
  it("names a conversation the list does not hold from the conversation itself", () => {
    expect(resolveCrumbTitle(undefined, { title: "Budget" }, "Nouvelle")).toBe("Budget");
  });

  it("prefers the list's row, which a rename updates live", () => {
    expect(resolveCrumbTitle({ title: "Renamed" }, { title: "Old" }, "Nouvelle")).toBe("Renamed");
  });

  it("falls back to the untitled label, and to null for an unknown conversation", () => {
    expect(resolveCrumbTitle({ title: null }, undefined, "Nouvelle")).toBe("Nouvelle");
    expect(resolveCrumbTitle(undefined, undefined, "Nouvelle")).toBeNull();
  });
});
