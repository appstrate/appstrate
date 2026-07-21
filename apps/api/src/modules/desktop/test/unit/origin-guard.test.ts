// SPDX-License-Identifier: Apache-2.0

/**
 * Origin guard on the desktop bridge upgrade (CSWSH defence).
 *
 * The WebSocket handshake is a cookie-carrying GET that CORS does not
 * police, so the only thing standing between a logged-in victim and a
 * malicious page registering itself as their desktop is this check.
 * The route-level 403 is covered in the integration suite; here we pin
 * the decision function itself, including the deliberate "no Origin →
 * allowed" carve-out for native clients.
 */

import { describe, it, expect } from "bun:test";
import { getEnv } from "@appstrate/env";
import { isTrustedUpgradeOrigin, substituteInValue } from "../../routes.ts";

describe("isTrustedUpgradeOrigin", () => {
  it("allows a request with no Origin (the Electron client sends none)", () => {
    expect(isTrustedUpgradeOrigin(undefined)).toBe(true);
  });

  it("allows the instance's own origin", () => {
    expect(isTrustedUpgradeOrigin(new URL(getEnv().APP_URL).origin)).toBe(true);
  });

  it("rejects a foreign origin", () => {
    expect(isTrustedUpgradeOrigin("https://evil.test")).toBe(false);
  });

  it("rejects a look-alike that merely embeds a trusted host", () => {
    const appOrigin = new URL(getEnv().APP_URL).origin;
    expect(isTrustedUpgradeOrigin(`https://evil.test?x=${appOrigin}`)).toBe(false);
    expect(isTrustedUpgradeOrigin(`${appOrigin}.evil.test`)).toBe(false);
  });

  it("rejects a malformed Origin rather than failing open", () => {
    expect(isTrustedUpgradeOrigin("not-a-url")).toBe(false);
  });
});

describe("substituteInValue", () => {
  const FIELDS = { password: "S3cret!Pass", email: "user@example.com" };

  it("replaces placeholders in nested strings", () => {
    const out = substituteInValue(
      { selector: "#pw", value: "{{password}}", meta: ["{{email}}", 42, null] },
      FIELDS,
    ) as { selector: string; value: string; meta: unknown[] };
    expect(out.value).toBe("S3cret!Pass");
    expect(out.meta).toEqual(["user@example.com", 42, null]);
    expect(out.selector).toBe("#pw");
  });

  it("leaves unknown placeholders intact (fail-safe, visible typo)", () => {
    expect(substituteInValue("{{passwrod}}", FIELDS)).toBe("{{passwrod}}");
  });

  it("substitutes inside larger strings", () => {
    expect(substituteInValue("login('{{email}}','{{password}}')", FIELDS)).toBe(
      "login('user@example.com','S3cret!Pass')",
    );
  });
});
