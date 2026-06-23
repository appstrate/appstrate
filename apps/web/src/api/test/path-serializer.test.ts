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

  it("keeps the / separator literal in scoped package ids", () => {
    expect(
      pathSerializer("/api/integrations/{packageId}/pins/{agentPackageId}", {
        packageId: "@official/gmail",
        agentPackageId: "@acme/my agent",
      }),
    ).toBe("/api/integrations/@official/gmail/pins/@acme/my%20agent");
  });

  it("does not split / in values that are not scoped package ids", () => {
    expect(pathSerializer("/api/end-users/{id}", { id: "a/b" })).toBe("/api/end-users/a%2Fb");
  });

  it("fully encodes a non-package param even when its value starts with @ (no shape guessing)", () => {
    // `id` is not a package-id param, so an @scope/name-shaped value must NOT
    // get its `@` or `/` relaxed — it routes to the literal {id} segment.
    expect(pathSerializer("/api/end-users/{id}", { id: "@weird/value" })).toBe(
      "/api/end-users/%40weird%2Fvalue",
    );
  });

  it("encodes @ in ordinary params (only scope/package params keep it literal)", () => {
    expect(pathSerializer("/api/end-users/{id}", { id: "user@example.com" })).toBe(
      "/api/end-users/user%40example.com",
    );
  });

  it("keeps @ literal in a bare scope param", () => {
    expect(
      pathSerializer("/api/packages/{scope}/{name}", { scope: "@myorg", name: "mailer" }),
    ).toBe("/api/packages/@myorg/mailer");
  });
});
