// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  formatCredentialStatus,
  parseCredentialStatus,
} from "../../../src/lib/credential-status-header.ts";

describe("X-Appstrate-Credential-Status", () => {
  it("writes `retry` with its counted rejection, and reads it back", () => {
    const value = formatCredentialStatus({
      status: "retry",
      cause: "unrefreshable",
      rejections: { failures: 2, maxFailures: 5 },
    });
    expect(value).toBe("retry; cause=unrefreshable; failures=2; max-failures=5");
    expect(parseCredentialStatus(value)).toEqual({
      status: "retry",
      cause: "unrefreshable",
      rejections: { failures: 2, maxFailures: 5 },
    });
  });

  it("writes `retry` without a count when the rejection was not counted", () => {
    const value = formatCredentialStatus({ status: "retry", cause: "upstream_transient" });
    expect(value).toBe("retry; cause=upstream_transient");
    expect(parseCredentialStatus(value)).toEqual({ status: "retry", cause: "upstream_transient" });
  });

  it("writes `dead` with its cause", () => {
    const value = formatCredentialStatus({ status: "dead", cause: "refresh_token_revoked" });
    expect(value).toBe("dead; cause=refresh_token_revoked");
    expect(parseCredentialStatus(value)).toEqual({
      status: "dead",
      cause: "refresh_token_revoked",
    });
  });

  it("reads nothing from a value the platform does not write", () => {
    expect(parseCredentialStatus(null)).toBeNull();
    expect(parseCredentialStatus("kept")).toBeNull();
    expect(parseCredentialStatus("dead")).toBeNull();
    expect(parseCredentialStatus("dead; cause=not_a_cause")).toBeNull();
    expect(parseCredentialStatus("refreshed; cause=unrefreshable")).toBeNull();
    expect(parseCredentialStatus("retry; cause")).toBeNull();
  });
});
