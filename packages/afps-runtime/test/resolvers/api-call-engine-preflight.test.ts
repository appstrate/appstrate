// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared engine's initial-URL preflight — the allowlist +
 * SSRF blocklist + DNS-rebind layer. Pins parity with the sidecar's
 * `executeApiCall` branches: a glob-host allowlist gets the SSRF gate,
 * a literal-host allowlist is the operator's trust declaration and is
 * exempt, allow_all and no-allowlist always get the gate.
 */

import { describe, it, expect, mock } from "bun:test";
import { preflightUrl, hostLiterallyAllowlisted } from "../../src/resolvers/api-call-engine.ts";

const publicResolver = async () => ["203.0.113.7"];
const internalResolver = async () => ["10.0.0.5"];

describe("hostLiterallyAllowlisted", () => {
  it("pins an exact literal host", () => {
    expect(
      hostLiterallyAllowlisted("https://api.example.com/x", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("never pins a glob host", () => {
    expect(hostLiterallyAllowlisted("https://anything.example/x", ["https://**"])).toBe(false);
    expect(hostLiterallyAllowlisted("https://a.example.com/x", ["https://*.example.com/**"])).toBe(
      false,
    );
  });

  it("tolerates a globbed scheme on a literal host", () => {
    expect(hostLiterallyAllowlisted("https://intranet.corp/x", ["**://intranet.corp/**"])).toBe(
      true,
    );
  });

  it("tolerates a globbed port on a literal host", () => {
    expect(
      hostLiterallyAllowlisted("https://intranet.corp/x", ["https://intranet.corp:*/**"]),
    ).toBe(true);
  });

  it("strips literal ports and userinfo from the spec authority", () => {
    expect(
      hostLiterallyAllowlisted("https://api.example.com/x", [
        "https://user@api.example.com:8443/**",
      ]),
    ).toBe(true);
  });

  it("compares hosts case-insensitively", () => {
    expect(
      hostLiterallyAllowlisted("https://API.Example.com/x", ["https://api.example.com/**"]),
    ).toBe(true);
  });

  it("returns false on an unparseable URL", () => {
    expect(hostLiterallyAllowlisted("::::", ["https://api.example.com/**"])).toBe(false);
  });
});

describe("preflightUrl — SSRF gate per branch", () => {
  it("allow_all: refuses a hostname resolving into a blocked range", async () => {
    const res = await preflightUrl("https://rebind.example/x", {
      allowAllUris: true,
      resolveHost: internalResolver,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ssrf");
  });

  it("allow_all: fails closed on resolution failure with a redacted host", async () => {
    const res = await preflightUrl("https://gone.example/secret?token=x", {
      allowAllUris: true,
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("gone.example");
      expect(res.message).not.toContain("token");
    }
  });

  it("no allowlist: same gate applies", async () => {
    const res = await preflightUrl("https://rebind.example/x", {
      resolveHost: internalResolver,
    });
    expect(res.ok).toBe(false);
  });

  it("glob-matched allowlist host stays behind the SSRF gate", async () => {
    const res = await preflightUrl("https://rebind.example/x", {
      authorizedUris: ["https://**"],
      resolveHost: internalResolver,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ssrf");
  });

  it("literal-host allowlist exempts an internal-resolving host (operator topology)", async () => {
    const resolveHost = mock(internalResolver);
    const res = await preflightUrl("https://intranet.corp/api", {
      authorizedUris: ["https://intranet.corp/**"],
      resolveHost,
    });
    expect(res.ok).toBe(true);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("off-allowlist target is refused before any DNS work", async () => {
    const resolveHost = mock(publicResolver);
    const res = await preflightUrl("https://evil.example/x", {
      authorizedUris: ["https://api.example.com/**"],
      resolveHost,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_authorized");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("IP-literal internal target is literal-blocked before DNS", async () => {
    const resolveHost = mock(publicResolver);
    const res = await preflightUrl("https://169.254.169.254/latest/meta-data", {
      allowAllUris: true,
      resolveHost,
    });
    expect(res.ok).toBe(false);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("public-resolving target proceeds on every gated branch", async () => {
    const branches: Array<{ allowAllUris?: boolean; authorizedUris?: string[] }> = [
      { allowAllUris: true },
      {},
      { authorizedUris: ["https://**"] },
    ];
    for (const opts of branches) {
      const res = await preflightUrl("https://ok.example/x", {
        ...opts,
        resolveHost: publicResolver,
      });
      expect(res.ok).toBe(true);
    }
  });
});
