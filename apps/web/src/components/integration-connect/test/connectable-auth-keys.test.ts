// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the connect gate. An oauth2 auth is connectable when a usable
 * client exists — org-registered (`has_oauth_client`), the shared platform
 * client (`has_system_client`, SYSTEM_INTEGRATION_CLIENTS), or auto-provisioned
 * at connect time (`client_auto_provisioned`, remote MCP CIMD/DCR). Without any,
 * the server refuses connect with 403, so the UI must not offer it. Pins the
 * single source of truth both the agent surfaces and the detail page consume.
 */

import { describe, it, expect } from "bun:test";
import type {
  IntegrationAuthStatus,
  IntegrationManifestView,
} from "../../../hooks/use-integrations";
import { connectableAuthKeys, isOauthAuthConnectable } from "../connectable-auth-keys";

function status(over: Partial<IntegrationAuthStatus>): IntegrationAuthStatus {
  return {
    auth_key: "google",
    type: "oauth2",
    required: true,
    scopes: [],
    resource: null,
    connections: [],
    has_oauth_client: false,
    has_system_client: false,
    client_auto_provisioned: false,
    ...over,
  };
}

describe("isOauthAuthConnectable", () => {
  it("is false when no client of any kind is available", () => {
    expect(isOauthAuthConnectable(status({}))).toBe(false);
  });

  it("is true with an org-registered client", () => {
    expect(isOauthAuthConnectable(status({ has_oauth_client: true }))).toBe(true);
  });

  it("is true with a shared system client (the unblock fix)", () => {
    expect(isOauthAuthConnectable(status({ has_system_client: true }))).toBe(true);
  });

  it("is true with an auto-provisioned client (remote MCP)", () => {
    expect(isOauthAuthConnectable(status({ client_auto_provisioned: true }))).toBe(true);
  });

  it("is false for an undefined status", () => {
    expect(isOauthAuthConnectable(undefined)).toBe(false);
  });
});

describe("connectableAuthKeys", () => {
  const manifest = {
    auths: {
      google: { type: "oauth2" },
      api: { type: "api_key" },
    },
  } as unknown as IntegrationManifestView;

  it("includes an oauth2 auth served only by a system client", () => {
    const out = connectableAuthKeys(manifest, [
      status({ auth_key: "google", has_system_client: true }),
    ]);
    expect(out.has("google")).toBe(true);
  });

  it("excludes an oauth2 auth with no usable client", () => {
    const out = connectableAuthKeys(manifest, [status({ auth_key: "google" })]);
    expect(out.has("google")).toBe(false);
  });

  it("always includes non-oauth2 auths (no client needed)", () => {
    const out = connectableAuthKeys(manifest, [status({ auth_key: "google" })]);
    expect(out.has("api")).toBe(true);
  });
});
