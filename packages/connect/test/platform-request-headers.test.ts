// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { VIEW_AS_HEADER } from "@appstrate/core/permissions";
import { isPlatformRequestHeader } from "../src/platform-request-headers.ts";

describe("isPlatformRequestHeader", () => {
  // The caller's platform credential, its tenancy and run, the platform's markers, the network
  // path to the platform and what an auth proxy in front of it asserts. Mixed case on purpose: the
  // rule reads a name whatever its case.
  for (const name of [
    "Authorization",
    "Cookie",
    "X-Org-Id",
    "x-space-id",
    "X-Run-Id",
    "X-View-As",
    "X-Appstrate-Internal-Dispatch",
    "x-appstrate-sidecar-auth",
    "Appstrate-Version",
    "Appstrate-User",
    // network path
    "Forwarded",
    "Via",
    "X-Forwarded-For",
    "x-forwarded-host",
    "X-Real-IP",
    "True-Client-IP",
    "X-Client-IP",
    "X-Original-Forwarded-For",
    "CDN-Loop",
    "CF-Connecting-IP",
    "cf-ray",
    "CF-Access-Jwt-Assertion",
    // auth-proxy identity
    "X-Amzn-Oidc-Data",
    "x-amzn-oidc-identity",
    "X-MS-CLIENT-PRINCIPAL",
    "x-ms-client-principal-name",
    "X-Ms-Token-Aad-Access-Token",
    "X-Goog-IAP-JWT-Assertion",
    "x-goog-authenticated-user-email",
    "X-Auth-Request-Email",
  ]) {
    it(`holds for ${name}`, () => {
      expect(isPlatformRequestHeader(name)).toBe(true);
    });
  }

  it("holds for the role-preview header core names", () => {
    expect(isPlatformRequestHeader(VIEW_AS_HEADER)).toBe(true);
  });

  // What a caller sends for the upstream, including names that only resemble a platform one.
  for (const name of [
    "Content-Type",
    "Accept",
    "User-Agent",
    "X-Api-Key",
    "CF-Access-Client-Id",
    "cf-access-client-secret",
    "X-Custom",
    "X-Organization-Id",
    "X-Session-Id",
    "Proxy-Authorization",
    "Set-Cookie",
    "X-Appstrated",
    "Appstrate",
    "Idempotency-Key",
    "X-Request-Id",
    "X-Auth-Email",
    "x-goog-user-project",
    "x-ms-useragent",
    "cfg-id",
    "X-Forwarded",
  ]) {
    it(`does not hold for ${name}`, () => {
      expect(isPlatformRequestHeader(name)).toBe(false);
    });
  }
});
