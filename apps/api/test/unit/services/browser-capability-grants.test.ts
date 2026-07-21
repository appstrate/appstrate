// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import type { McpServerBrowserCapability } from "@appstrate/core/mcp-server";
import {
  authorizeBrowserCapability,
  BrowserCapabilityPolicyError,
  initBrowserCapabilityGrants,
  resetBrowserCapabilityGrantsForTest,
} from "../../../src/services/browser-capability-grants.ts";

const automation: McpServerBrowserCapability = {
  purpose: "automation",
  protocol: "cdp-v1",
  profile: "standard",
  origins: ["https://example.com"],
};

const connection: McpServerBrowserCapability = {
  ...automation,
  purpose: "connection-acquisition",
  origins: ["https://www.leboncoin.fr", "https://auth.leboncoin.fr"],
};

const enabled = { browserEnabled: true, browserConnectEnabled: true };

describe("browser capability grants", () => {
  beforeEach(() => resetBrowserCapabilityGrantsForTest());

  it("gates every browser capability behind the general operator switch", () => {
    try {
      authorizeBrowserCapability(
        {
          packageId: "@appstrate/browser",
          version: "1.0.0",
          source: "system",
          capability: automation,
        },
        { browserEnabled: false, browserConnectEnabled: false },
      );
      throw new Error("expected browser policy denial");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserCapabilityPolicyError);
      expect((error as BrowserCapabilityPolicyError).code).toBe("BROWSER_POLICY_DENIED");
      expect((error as Error).message).toContain("disabled by operator policy");
    }
  });

  it("allows ordinary automation without granting secret access", () => {
    expect(
      authorizeBrowserCapability(
        {
          packageId: "@third-party/browser",
          version: "2.0.0",
          source: "version",
          capability: automation,
        },
        enabled,
      ),
    ).toEqual({ trustedDriver: false });
  });

  it("requires initialization and a matching package/version grant for connection acquisition", () => {
    expect(() =>
      authorizeBrowserCapability(
        {
          packageId: "@appstrate/leboncoin-browser",
          version: "1.2.0",
          source: "system",
          capability: connection,
        },
        enabled,
      ),
    ).toThrow(/not initialized/);

    initBrowserCapabilityGrants([
      {
        id: "leboncoin",
        packageId: "@appstrate/leboncoin-browser",
        versionRange: "^1.0.0",
      },
    ]);

    expect(
      authorizeBrowserCapability(
        {
          packageId: "@appstrate/leboncoin-browser",
          version: "1.2.0",
          source: "system",
          capability: connection,
        },
        enabled,
      ),
    ).toEqual({ trustedDriver: true, driverGrantId: "leboncoin" });

    expect(() =>
      authorizeBrowserCapability(
        {
          packageId: "@appstrate/leboncoin-browser",
          version: "2.0.0",
          source: "system",
          capability: connection,
        },
        enabled,
      ),
    ).toThrow(/no matching operator grant/);
  });

  it("enforces an optional grant-level origin ceiling", () => {
    initBrowserCapabilityGrants([
      {
        id: "leboncoin",
        packageId: "@appstrate/leboncoin-browser",
        versionRange: "*",
        origins: ["https://www.leboncoin.fr"],
      },
    ]);

    expect(() =>
      authorizeBrowserCapability(
        {
          packageId: "@appstrate/leboncoin-browser",
          version: "1.0.0",
          source: "system",
          capability: connection,
        },
        enabled,
      ),
    ).toThrow(/no matching operator grant/);
  });

  it("never grants bootstrap-secret access to an org-owned package", () => {
    initBrowserCapabilityGrants([
      {
        id: "reserved-driver",
        packageId: "@appstrate/leboncoin-browser",
        versionRange: "*",
      },
    ]);

    expect(() =>
      authorizeBrowserCapability(
        {
          packageId: "@appstrate/leboncoin-browser",
          version: "1.0.0",
          source: "version",
          capability: connection,
        },
        enabled,
      ),
    ).toThrow(/restricted to system packages/);
  });

  it("fails boot-time parsing on malformed or duplicate grants", () => {
    expect(() =>
      initBrowserCapabilityGrants([{ id: "bad", packageId: "not-scoped", versionRange: "latest" }]),
    ).toThrow(/invalid/);

    expect(() =>
      initBrowserCapabilityGrants([
        {
          id: "unsafe_origin",
          packageId: "@appstrate/one",
          versionRange: "*",
          origins: ["https://example.com/login"],
        },
      ]),
    ).toThrow(/canonical exact https origin/);

    expect(() =>
      initBrowserCapabilityGrants([
        { id: "same", packageId: "@appstrate/one", versionRange: "*" },
        { id: "same", packageId: "@appstrate/two", versionRange: "*" },
      ]),
    ).toThrow(/duplicate id/);
  });
});
