// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  validateConnectToolResult,
  ConnectToolContractError,
} from "../../src/connect/tool-contract.ts";

describe("validateConnectToolResult — produces gating", () => {
  it("projects outputs down to exactly the declared produces set", () => {
    const res = validateConnectToolResult(
      { outputs: { JSESSIONID: "abc", AWSALB: "lb", extra_cookie: "x" } },
      ["JSESSIONID", "AWSALB"],
    );
    // `extra_cookie` is dropped — produces is the authoritative injectable set.
    expect(res.outputs).toEqual({ JSESSIONID: "abc", AWSALB: "lb" });
  });

  it("fails closed when a declared output is missing", () => {
    const err = (() => {
      try {
        validateConnectToolResult({ outputs: { JSESSIONID: "abc" } }, ["JSESSIONID", "AWSALB"]);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConnectToolContractError);
    expect((err as ConnectToolContractError).reason).toBe("missing_output");
    expect((err as ConnectToolContractError).missing).toEqual(["AWSALB"]);
  });

  it("keeps all string outputs when no produces is declared", () => {
    const res = validateConnectToolResult({ outputs: { a: "1", b: "2" } });
    expect(res.outputs).toEqual({ a: "1", b: "2" });
  });

  it("rejects an empty outputs map with no produces", () => {
    expect(() => validateConnectToolResult({ outputs: {} })).toThrow(/no outputs/);
  });

  it("rejects a non-object / missing outputs result", () => {
    expect(() => validateConnectToolResult(null)).toThrow(ConnectToolContractError);
    expect(() => validateConnectToolResult({ nope: 1 })).toThrow(/`outputs` map/);
  });

  it("drops non-string output values", () => {
    const res = validateConnectToolResult({ outputs: { tok: "t", n: 5, obj: {} } });
    expect(res.outputs).toEqual({ tok: "t" });
  });
});

describe("validateConnectToolResult — optional metadata", () => {
  it("passes through identity claims, scopes, and expiry", () => {
    const res = validateConnectToolResult({
      outputs: { tok: "t" },
      identityClaims: { person_id: "P-42" },
      scopesGranted: ["read", "write", 7],
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
    expect(res.identityClaims).toEqual({ person_id: "P-42" });
    expect(res.scopesGranted).toEqual(["read", "write"]); // non-string dropped
    expect(res.expiresAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("treats expiresAt:null as durable", () => {
    const res = validateConnectToolResult({ outputs: { tok: "t" }, expiresAt: null });
    expect(res.expiresAt).toBeNull();
  });

  it("never echoes output values in a contract error message", () => {
    try {
      validateConnectToolResult({ outputs: { JSESSIONID: "super-secret-session" } }, ["MISSING"]);
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-session");
    }
  });
});
