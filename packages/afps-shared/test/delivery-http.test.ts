// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { isBareAuthSchemePrefix, projectHttpDeliveryConfig } from "../src/delivery-http.ts";

describe("projectHttpDeliveryConfig", () => {
  it("returns undefined for an absent block", () => {
    expect(projectHttpDeliveryConfig(undefined)).toBeUndefined();
  });

  it("lowers a single {$credential.field} ref to a bare valueFrom", () => {
    const cfg = projectHttpDeliveryConfig({ name: "X-Api-Key", value: "{$credential.api_key}" });
    expect(cfg).toEqual({ headerName: "X-Api-Key", valueFrom: "api_key" });
  });

  it("rewrites a composite value to a {{field}} template", () => {
    const cfg = projectHttpDeliveryConfig({
      name: "Authorization",
      prefix: "Bearer ",
      value: "{$credential.token_type} {$credential.access_token}",
    });
    expect(cfg).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      valueFrom: { template: "{{token_type}} {{access_token}}" },
    });
  });

  it("keeps a single ref as a template when base64 encoding is requested", () => {
    const cfg = projectHttpDeliveryConfig({
      name: "Authorization",
      value: "{$credential.user}:{$credential.pass}",
      encoding: "base64",
    });
    expect(cfg).toEqual({
      valueFrom: { template: "{{user}}:{{pass}}", encoding: "base64" },
      headerName: "Authorization",
    });
  });

  it("carries allow_server_override → allowServerOverride", () => {
    const cfg = projectHttpDeliveryConfig({ name: "X", allow_server_override: true });
    expect(cfg).toEqual({ headerName: "X", allowServerOverride: true });
  });
});

// The one grammar behind both bare-prefix gates — the integration manifest
// validator (install time) and the portable runtime's local creds file (load
// time). Each gate pins its own message; this pins what they agree on.
describe("isBareAuthSchemePrefix", () => {
  it("is true for a prefix that is nothing but a scheme, in credentials position", () => {
    for (const header of ["Authorization", "authorization", "Proxy-Authorization"]) {
      expect(isBareAuthSchemePrefix(header, "Bearer")).toBe(true);
    }
    expect(isBareAuthSchemePrefix("Authorization", "Zoho-oauthtoken")).toBe(true);
  });

  it("is false for a prefix carrying its own separator, and for no prefix at all", () => {
    for (const prefix of ["Bearer ", "Basic ", "Token token=", ""]) {
      expect(isBareAuthSchemePrefix("Authorization", prefix)).toBe(false);
    }
  });

  it("is false outside credentials position — there a bare token is an ordinary literal", () => {
    expect(isBareAuthSchemePrefix("Cookie", "session")).toBe(false);
    expect(isBareAuthSchemePrefix("X-Api-Key", "Token")).toBe(false);
  });
});
