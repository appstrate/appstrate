// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "bun:test";
import {
  mintConnectSession,
  verifyConnectSession,
  type ConnectSessionClaims,
} from "../src/connect-session-token.ts";

const SECRET = "test-connect-secret-0123456789abcdef";

function baseClaims(overrides?: Partial<ConnectSessionClaims>): ConnectSessionClaims {
  return {
    v: 1,
    org_id: "org_1",
    application_id: "app_1",
    user_id: "user_1",
    package_id: "@acme/widget",
    auth_key: "api_key",
    jti: "jti-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

describe("connect-session-token", () => {
  it("round-trips valid claims", () => {
    const token = mintConnectSession(baseClaims(), SECRET);
    const decoded = verifyConnectSession(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.org_id).toBe("org_1");
    expect(decoded?.package_id).toBe("@acme/widget");
    expect(decoded?.auth_key).toBe("api_key");
  });

  it("preserves optional reconnect + scopes fields", () => {
    const token = mintConnectSession(
      baseClaims({ connection_id: "conn_1", scopes: ["read", "write"] }),
      SECRET,
    );
    const decoded = verifyConnectSession(token, SECRET);
    expect(decoded?.connection_id).toBe("conn_1");
    expect(decoded?.scopes).toEqual(["read", "write"]);
  });

  it("rejects a tampered signature", () => {
    const token = mintConnectSession(baseClaims(), SECRET);
    const tampered = `${token}x`;
    expect(verifyConnectSession(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = mintConnectSession(baseClaims(), SECRET);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify(baseClaims({ org_id: "org_evil" })), "utf-8").toString(
      "base64url",
    );
    expect(verifyConnectSession(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a wrong secret", () => {
    const token = mintConnectSession(baseClaims(), SECRET);
    expect(verifyConnectSession(token, "another-secret-0123456789abcdef")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = mintConnectSession(
      baseClaims({ exp: Math.floor(Date.now() / 1000) - 1 }),
      SECRET,
    );
    expect(verifyConnectSession(token, SECRET)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyConnectSession("", SECRET)).toBeNull();
    expect(verifyConnectSession("no-dot", SECRET)).toBeNull();
    expect(verifyConnectSession(".onlysig", SECRET)).toBeNull();
  });

  it("verifies tokens signed before a key rotation (keyring)", () => {
    const oldKey = "old-connect-secret-0123456789abcd";
    const newKey = "new-connect-secret-0123456789abcd";
    const token = mintConnectSession(baseClaims(), oldKey);
    // After rotation the new key signs but both verify.
    const keyring = [newKey, oldKey];
    expect(verifyConnectSession(token, keyring)).not.toBeNull();
    // New tokens are signed with the first key.
    const fresh = mintConnectSession(baseClaims(), keyring);
    expect(verifyConnectSession(fresh, oldKey)).toBeNull();
    expect(verifyConnectSession(fresh, newKey)).not.toBeNull();
  });

  it("enforces exactly one actor at mint", () => {
    expect(() =>
      mintConnectSession(baseClaims({ user_id: undefined, end_user_id: undefined }), SECRET),
    ).toThrow();
    expect(() =>
      mintConnectSession(baseClaims({ user_id: "user_1", end_user_id: "eu_1" }), SECRET),
    ).toThrow();
  });

  it("accepts an end-user actor", () => {
    const token = mintConnectSession(
      baseClaims({ user_id: undefined, end_user_id: "eu_1" }),
      SECRET,
    );
    const decoded = verifyConnectSession(token, SECRET);
    expect(decoded?.end_user_id).toBe("eu_1");
    expect(decoded?.user_id).toBeUndefined();
  });

  it("requires a signing key at mint", () => {
    expect(() => mintConnectSession(baseClaims(), "")).toThrow();
    expect(() => mintConnectSession(baseClaims(), [])).toThrow();
  });
});
