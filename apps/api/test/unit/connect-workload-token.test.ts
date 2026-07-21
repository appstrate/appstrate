// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { _resetCacheForTesting } from "@appstrate/env";

import {
  parseConnectWorkloadToken,
  signConnectWorkloadToken,
} from "../../src/lib/connect-workload-token.ts";
import { parseSignedToken } from "../../src/lib/run-token.ts";

const SECRET = "connect-workload-token-test-secret-32chars";
const originalSecret = process.env.RUN_TOKEN_SECRET;

beforeAll(() => {
  process.env.RUN_TOKEN_SECRET = SECRET;
  _resetCacheForTesting();
});

afterAll(() => {
  process.env.RUN_TOKEN_SECRET = originalSecret;
  _resetCacheForTesting();
});

function token(now = 1_000) {
  return signConnectWorkloadToken(
    {
      connectId: "browser_connect_123",
      orgId: "org-1",
      applicationId: "app-1",
      integrationId: "@appstrate/leboncoin",
      mcpServerId: "@appstrate/leboncoin-browser",
      mcpServerVersion: null,
      mcpServerSource: "system",
      ttlMs: 60_000,
    },
    now,
  );
}

describe("connect workload token", () => {
  it("round-trips a purpose-bound, expiring bundle grant", () => {
    expect(parseConnectWorkloadToken(token(), 30_000)).toEqual({
      audience: "internal:mcp-server-bundle",
      connectId: "browser_connect_123",
      orgId: "org-1",
      applicationId: "app-1",
      integrationId: "@appstrate/leboncoin",
      mcpServerId: "@appstrate/leboncoin-browser",
      mcpServerVersion: null,
      mcpServerSource: "system",
      issuedAt: 1_000,
      expiresAt: 61_000,
    });
    expect(parseConnectWorkloadToken(token(), 61_000)).toBeNull();
  });

  it("is domain-separated from normal run tokens", () => {
    expect(parseSignedToken(token())).toBeNull();
  });

  it("rejects tampering with every tenancy and package binding", () => {
    const original = token();
    const [prefix, payload, signature] = original.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    for (const [field, value] of [
      ["orgId", "org-2"],
      ["applicationId", "app-2"],
      ["integrationId", "@other/integration"],
      ["mcpServerId", "@other/server"],
    ] as const) {
      const changed = { ...claims, [field]: value };
      const changedPayload = Buffer.from(JSON.stringify(changed)).toString("base64url");
      expect(
        parseConnectWorkloadToken(`${prefix}.${changedPayload}.${signature}`, 30_000),
      ).toBeNull();
    }
  });

  it("rejects invalid provenance and overlong grants", () => {
    expect(() =>
      signConnectWorkloadToken({
        connectId: "connect_1",
        orgId: "org-1",
        applicationId: "app-1",
        integrationId: "@scope/integration",
        mcpServerId: "@scope/server",
        mcpServerVersion: null,
        mcpServerSource: "version",
        ttlMs: 60_000,
      }),
    ).toThrow();
    expect(() =>
      signConnectWorkloadToken({
        connectId: "connect_1",
        orgId: "org-1",
        applicationId: "app-1",
        integrationId: "@scope/integration",
        mcpServerId: "@scope/server",
        mcpServerVersion: "1.0.0",
        mcpServerSource: "version",
        ttlMs: 5 * 60_000 + 1,
      }),
    ).toThrow(/ttl/);
  });
});
