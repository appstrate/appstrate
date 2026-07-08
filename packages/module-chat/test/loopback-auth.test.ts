// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CHAT_LOOPBACK_AUTH_METHOD,
  chatLoopbackStrategy,
  mintLoopbackToken,
  mintMcpLoopbackToken,
} from "../src/loopback-auth.ts";

const claims = {
  userId: "u_1",
  email: "a@b.c",
  name: "Ada",
  orgId: "org_1",
  orgRole: "member",
};

function authHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

describe("mintLoopbackToken + chatLoopbackStrategy round-trip", () => {
  it("a freshly minted token authenticates back to the caller's identity", async () => {
    const token = mintLoopbackToken(claims);
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(token) } as never);
    expect(res).not.toBeNull();
    expect(res!.user).toEqual({ id: "u_1", email: "a@b.c", name: "Ada" });
    expect(res!.orgId).toBe("org_1");
    expect(res!.orgRole).toBe("member");
    expect(res!.authMethod).toBe(CHAT_LOOPBACK_AUTH_METHOD);
  });

  it("resolves exactly the least-privilege permission set", async () => {
    const res = await chatLoopbackStrategy.authenticate({
      headers: authHeaders(mintLoopbackToken(claims)),
    } as never);
    expect(res!.permissions).toEqual(["llm-proxy:call", "models:read"]);
  });

  it("the inference bearer grants the first-party-loopback capability", async () => {
    const res = await chatLoopbackStrategy.authenticate({
      headers: authHeaders(mintLoopbackToken(claims)),
    } as never);
    expect(res!.firstPartyLoopback).toBe(true);
  });
});

describe("mintMcpLoopbackToken (subscription-engine platform-MCP bearer)", () => {
  const callerPermissions = ["mcp:read", "agents:read", "runs:write"];

  it("resolves back to EXACTLY the caller's forwarded permission set (RBAC fidelity, no amplification)", async () => {
    const token = mintMcpLoopbackToken({ ...claims, permissions: callerPermissions });
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(token) } as never);
    expect(res).not.toBeNull();
    expect(res!.permissions).toEqual(callerPermissions);
    expect(res!.user).toEqual({ id: "u_1", email: "a@b.c", name: "Ada" });
    expect(res!.orgId).toBe("org_1");
  });

  it("does NOT grant first-party-loopback — the MCP bearer can never reach the subscription LLM gateway", async () => {
    const token = mintMcpLoopbackToken({ ...claims, permissions: callerPermissions });
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(token) } as never);
    // Falsy (unset or false) so `if (resolution.firstPartyLoopback)` in the
    // auth pipeline never stamps the capability for this token.
    expect(res!.firstPartyLoopback).not.toBe(true);
  });

  it("an expired MCP bearer is refused", async () => {
    const token = mintMcpLoopbackToken(
      { ...claims, permissions: callerPermissions },
      { ttlMs: -1 },
    );
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(token) } as never);
    expect(res).toBeNull();
  });
});

describe("chatLoopbackStrategy rejection paths", () => {
  it("no-match: a foreign Authorization header passes straight through (null)", async () => {
    const res = await chatLoopbackStrategy.authenticate({
      headers: new Headers({ authorization: "Bearer ask_somethingelse" }),
    } as never);
    expect(res).toBeNull();
  });

  it("no-match: a missing Authorization header is ignored", async () => {
    const res = await chatLoopbackStrategy.authenticate({ headers: new Headers() } as never);
    expect(res).toBeNull();
  });

  it("expired token is refused", async () => {
    const token = mintLoopbackToken(claims, { ttlMs: -1 });
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(token) } as never);
    expect(res).toBeNull();
  });

  it("tampered signature is refused", async () => {
    const token = mintLoopbackToken(claims);
    const [payload] = token.slice("chatloop_".length).split(".");
    const forged = `chatloop_${payload}.${"A".repeat(43)}`;
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(forged) } as never);
    expect(res).toBeNull();
  });

  it("tampered payload (valid shape, wrong signature) is refused", async () => {
    const good = mintLoopbackToken(claims);
    const evil = mintLoopbackToken({ ...claims, orgRole: "owner" });
    const goodSig = good.slice("chatloop_".length).split(".")[1];
    const evilPayload = evil.slice("chatloop_".length).split(".")[0];
    // Graft the elevated payload onto the original signature.
    const forged = `chatloop_${evilPayload}.${goodSig}`;
    const res = await chatLoopbackStrategy.authenticate({ headers: authHeaders(forged) } as never);
    expect(res).toBeNull();
  });

  it("malformed token (no dot separator) is refused", async () => {
    const res = await chatLoopbackStrategy.authenticate({
      headers: authHeaders("chatloop_garbage"),
    } as never);
    expect(res).toBeNull();
  });
});
