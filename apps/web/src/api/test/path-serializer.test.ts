// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { pathSerializer } from "../client";

describe("pathSerializer", () => {
  it("keeps @ literal in scope params (Hono regex routes match the raw path)", () => {
    expect(
      pathSerializer("/api/agents/{scope}/{name}/run", { scope: "@myorg", name: "mailer" }),
    ).toBe("/api/agents/@myorg/mailer/run");
  });

  it("percent-encodes everything else, including path separators", () => {
    expect(pathSerializer("/api/end-users/{id}", { id: "a/b c%" })).toBe(
      "/api/end-users/a%2Fb%20c%25",
    );
  });

  it("leaves unmatched params in place", () => {
    expect(pathSerializer("/api/runs/{id}", {})).toBe("/api/runs/{id}");
  });
});
