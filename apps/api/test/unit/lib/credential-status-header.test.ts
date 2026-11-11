// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  formatCredentialStatus,
  parseCredentialStatus,
} from "../../../src/lib/credential-status-header.ts";

describe("X-Appstrate-Credential-Status", () => {
  it("writes `retry` as `in_use` with its counted rejection, and reads it back", () => {
    const value = formatCredentialStatus({
      status: "retry",
      cause: "unrefreshable",
      rejections: { failures: 2, maxFailures: 5 },
    });
    expect(value).toBe("in_use; cause=unrefreshable; failures=2; max-failures=5");
    expect(parseCredentialStatus(value)).toEqual({
      status: "in_use",
      cause: "unrefreshable",
      rejections: { failures: 2, maxFailures: 5 },
    });
  });

  it("writes `in_use` without a count when the rejection was not counted", () => {
    const value = formatCredentialStatus({ status: "retry", cause: "upstream_transient" });
    expect(value).toBe("in_use; cause=upstream_transient");
    expect(parseCredentialStatus(value)).toEqual({
      status: "in_use",
      cause: "upstream_transient",
    });
  });

  it("writes `dead` as `needs_reconnection` with its cause", () => {
    const value = formatCredentialStatus({ status: "dead", cause: "refresh_token_revoked" });
    expect(value).toBe("needs_reconnection; cause=refresh_token_revoked");
    expect(parseCredentialStatus(value)).toEqual({
      status: "needs_reconnection",
      cause: "refresh_token_revoked",
    });
  });

  it("reads nothing from a value the platform does not write", () => {
    expect(parseCredentialStatus(null)).toBeNull();
    expect(parseCredentialStatus("kept")).toBeNull();
    expect(parseCredentialStatus("needs_reconnection")).toBeNull();
    expect(parseCredentialStatus("needs_reconnection; cause=not_a_cause")).toBeNull();
    expect(parseCredentialStatus("refreshed; cause=unrefreshable")).toBeNull();
    expect(parseCredentialStatus("in_use; cause")).toBeNull();
    // The internal verdict names are never written, so never read.
    expect(parseCredentialStatus("retry; cause=unrefreshable")).toBeNull();
    expect(parseCredentialStatus("dead; cause=refresh_token_revoked")).toBeNull();
  });
});
