// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ABOUT_ME, createMemoryBody } from "../user-memory";

describe("createMemoryBody", () => {
  it("sends no origin for 'about me' and trims, blank subject as null", () => {
    expect(
      createMemoryBody({
        type: "preference",
        content: "  Short answers ",
        subject: " ",
        origin: ABOUT_ME,
      }),
    ).toEqual({ type: "preference", content: "Short answers", subject: null, orgId: null });
  });

  it("sends the organization id as origin", () => {
    const orgId = "0b8f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(
      createMemoryBody({ type: "project", content: "Map", subject: "Tastet", origin: orgId }),
    ).toEqual({ type: "project", content: "Map", subject: "Tastet", orgId });
  });
});
