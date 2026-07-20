// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { _test as stateTest } from "../src/browser-state.ts";
import { parseCompanionCapability, validateCompanionContext } from "../src/protocol.ts";

const ID = "018f0c67-98ab-7def-8123-123456789abc";
const TOKEN = "a".repeat(43);

describe("companion capability protocol", () => {
  it("accepts HTTPS and loopback endpoints", () => {
    const value = parseCompanionCapability(
      `appstrate-browser://connect?endpoint=${encodeURIComponent(`https://app.example/api/integrations/connect/companion/attempts/${ID}`)}&token=${TOKEN}`,
    );
    expect(value.endpoint.origin).toBe("https://app.example");
    expect(value.token).toBe(TOKEN);
    expect(
      parseCompanionCapability(
        `appstrate-browser://connect?endpoint=${encodeURIComponent(`http://localhost:3000/api/integrations/connect/companion/attempts/${ID}`)}&token=${TOKEN}`,
      ).endpoint.port,
    ).toBe("3000");
  });

  it("rejects cleartext remote, credentialed, and off-path endpoints", () => {
    for (const endpoint of [
      `http://app.example/api/integrations/connect/companion/attempts/${ID}`,
      `https://user:pass@app.example/api/integrations/connect/companion/attempts/${ID}`,
      `https://app.example/api/admin/${ID}`,
      `https://app.example/api/integrations/connect/companion/attempts/${ID}?redirect=evil`,
    ]) {
      expect(() =>
        parseCompanionCapability(
          `appstrate-browser://connect?endpoint=${encodeURIComponent(endpoint)}&token=${TOKEN}`,
        ),
      ).toThrow();
    }
  });

  it("validates every API-controlled URL before passing it to Chrome or the OS", () => {
    const capability = parseCompanionCapability(
      `appstrate-browser://connect?endpoint=${encodeURIComponent(`https://app.example/api/integrations/connect/companion/attempts/${ID}`)}&token=${TOKEN}`,
    );
    const valid = {
      attempt_id: ID,
      package_id: "@appstrate/leboncoin",
      display_name: "Leboncoin",
      start_url: "https://www.leboncoin.fr/compte/part/mes-annonces",
      allowed_origins: ["https://www.leboncoin.fr"],
      target_provider: "browser-use-cloud",
      status: "claimed",
      interaction_url: null,
      error_code: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(validateCompanionContext(valid, capability).start_url).toBe(valid.start_url);
    expect(() =>
      validateCompanionContext({ ...valid, start_url: "--load-extension=/tmp/evil" }, capability),
    ).toThrow("Unsafe companion start URL");
    expect(() =>
      validateCompanionContext(
        { ...valid, allowed_origins: ["https://*.leboncoin.fr"] },
        capability,
      ),
    ).toThrow("Unsafe companion origin");
    expect(() =>
      validateCompanionContext({ ...valid, interaction_url: "file:///tmp/secret" }, capability),
    ).toThrow("Unsafe provider interaction URL");
    expect(() =>
      validateCompanionContext({ ...valid, attempt_id: crypto.randomUUID() }, capability),
    ).toThrow("Malformed companion context");
  });
});

describe("portable state filtering", () => {
  it("normalizes CDP cookies to the target storage-state vocabulary", () => {
    expect(
      stateTest.cookieForPortableState({
        name: "session",
        value: "value",
        domain: ".www.leboncoin.fr",
        path: "/",
        expires: 123,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      }),
    ).toEqual({
      name: "session",
      value: "value",
      domain: ".www.leboncoin.fr",
      path: "/",
      expires: 123,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
  });

  it("accepts only exact allowlisted cookie domains", () => {
    const origins = new Set(["https://www.leboncoin.fr"]);
    expect(stateTest.domainAllowed(".www.leboncoin.fr", origins)).toBe(true);
    expect(stateTest.domainAllowed("leboncoin.fr", origins)).toBe(false);
    expect(stateTest.domainAllowed("evil.example", origins)).toBe(false);
  });
});
