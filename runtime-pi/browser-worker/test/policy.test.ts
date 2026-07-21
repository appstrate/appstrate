// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  browserCommandDenial,
  DEFAULT_BROWSER_CONTEXT,
  hasValidCdpCommandEnvelope,
  isCookieDomainAllowed,
  isReadOnlyDevtoolsDiscoveryRequest,
  parseAllowedOrigins,
} from "../policy.ts";

describe("browser worker DevTools HTTP policy", () => {
  it("allows discovery but refuses every mutation bypass", () => {
    expect(isReadOnlyDevtoolsDiscoveryRequest("GET", "/json/version", "")).toBe(true);
    expect(isReadOnlyDevtoolsDiscoveryRequest("GET", "/json/list", "")).toBe(true);
    expect(isReadOnlyDevtoolsDiscoveryRequest("PUT", "/json/new", "?https://example.com")).toBe(
      false,
    );
    expect(isReadOnlyDevtoolsDiscoveryRequest("GET", "/json/close/target", "")).toBe(false);
    expect(isReadOnlyDevtoolsDiscoveryRequest("GET", "/json/version", "?secret=value")).toBe(false);
  });
});

describe("browser worker CDP envelope policy", () => {
  it("requires every command to carry a bounded numeric response id", () => {
    expect(hasValidCdpCommandEnvelope("Browser.close", 1)).toBe(true);
    expect(hasValidCdpCommandEnvelope("Browser.close", undefined)).toBe(false);
    expect(hasValidCdpCommandEnvelope("Browser.close", "1")).toBe(false);
    expect(hasValidCdpCommandEnvelope("Browser.close", Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(hasValidCdpCommandEnvelope(undefined, undefined)).toBe(false);
    expect(hasValidCdpCommandEnvelope("", 1)).toBe(false);
  });
});

describe("browser worker origin policy", () => {
  it("accepts only one to 64 canonical exact HTTPS origins", () => {
    expect(parseAllowedOrigins('["https://example.com"]')).toEqual(["https://example.com"]);
    for (const raw of [
      undefined,
      "[]",
      '["http://example.com"]',
      '["https://example.com/"]',
      '["https://example.com/path"]',
      '["https://user:secret@example.com"]',
    ]) {
      expect(() => parseAllowedOrigins(raw), String(raw)).toThrow(
        /BROWSER_ALLOWED_ORIGINS_JSON is invalid/,
      );
    }
  });
});

describe("browser worker CDP policy", () => {
  const base = {
    activeContext: "context-1",
    pageTargets: 0,
    pendingPageCreations: 0,
    maxPages: 2,
  };

  it("owns browser lifecycle and context creation", () => {
    for (const method of [
      "Browser.close",
      "Target.createBrowserContext",
      "Target.disposeBrowserContext",
    ]) {
      expect(browserCommandDenial({ ...base, method })).toMatch(/owned by the Appstrate worker/);
    }
  });

  it("blocks CDP tunnelling primitives that could bypass the broker", () => {
    for (const method of [
      "Target.attachToBrowserTarget",
      "Target.exposeDevToolsProtocol",
      "Target.sendMessageToTarget",
    ]) {
      expect(browserCommandDenial({ ...base, method })).toMatch(/nested DevTools/);
    }
  });

  it("forces pages and cookie access into the one managed context", () => {
    expect(browserCommandDenial({ ...base, method: "Target.createTarget" })).toMatch(
      /Appstrate-owned browser context/,
    );
    expect(
      browserCommandDenial({
        ...base,
        method: "Storage.getCookies",
        browserContextId: "other",
      }),
    ).toMatch(/cookie access/);
    expect(
      browserCommandDenial({
        ...base,
        method: "Target.createTarget",
        browserContextId: "context-1",
      }),
    ).toBeNull();
  });

  it("counts in-flight creations against the page ceiling", () => {
    expect(
      browserCommandDenial({
        ...base,
        method: "Target.createTarget",
        browserContextId: "context-1",
        pageTargets: 1,
        pendingPageCreations: 1,
      }),
    ).toBe("browser page limit reached");
  });

  it("allows Playwright's omitted context id only for the owned default profile", () => {
    expect(
      browserCommandDenial({
        ...base,
        activeContext: DEFAULT_BROWSER_CONTEXT,
        method: "Target.createTarget",
      }),
    ).toBeNull();
    expect(
      browserCommandDenial({
        ...base,
        activeContext: DEFAULT_BROWSER_CONTEXT,
        browserContextId: "foreign",
        method: "Target.createTarget",
      }),
    ).toMatch(/Appstrate-owned/);
  });
});

describe("browser worker restored-cookie policy", () => {
  it("requires an exact declared cookie domain and rejects broad parents", () => {
    const origins = ["https://example.com", "https://auth.example.com"];
    expect(isCookieDomainAllowed(".example.com", origins)).toBe(true);
    expect(isCookieDomainAllowed("auth.example.com", origins)).toBe(true);
    expect(isCookieDomainAllowed("com", origins)).toBe(false);
    expect(isCookieDomainAllowed("other.example.com", origins)).toBe(false);
  });
});
