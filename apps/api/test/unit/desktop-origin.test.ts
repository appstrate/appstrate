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
import { isTrustedUpgradeOrigin } from "../../src/routes/desktop.ts";
import { getEnv } from "@appstrate/env";

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
