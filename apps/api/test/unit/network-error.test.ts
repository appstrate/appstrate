// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { mapFetchErrorToTestResult } from "../../src/lib/network-error.ts";

/** A local port nothing listens on: bound to learn a free number, then closed. */
function closedPort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

describe("mapFetchErrorToTestResult", () => {
  it("names a refused connection from the rejection Bun really produces", async () => {
    const rejection = await fetch(`http://127.0.0.1:${closedPort()}/`).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejection).not.toBeNull();
    expect(mapFetchErrorToTestResult(rejection, 3)).toEqual({
      ok: false,
      latency: 3,
      error: "CONNECTION_REFUSED",
      message: "Connection refused",
    });
  });

  it("reads the code of a wrapped cause, and still reads an errno in the message", () => {
    const wrapped = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(mapFetchErrorToTestResult(wrapped, 0).error).toBe("CONNECTION_REFUSED");
    expect(mapFetchErrorToTestResult(new Error("getaddrinfo ENOTFOUND x.invalid"), 0).error).toBe(
      "DNS_ERROR",
    );
    expect(
      mapFetchErrorToTestResult(
        Object.assign(new TypeError("self signed certificate"), {
          code: "DEPTH_ZERO_SELF_SIGNED_CERT",
        }),
        0,
      ).error,
    ).toBe("TLS_ERROR");
  });

  it("keeps the message of a failure it cannot classify", () => {
    expect(mapFetchErrorToTestResult(new Error("something else"), 0)).toMatchObject({
      error: "NETWORK_ERROR",
      message: "something else",
    });
  });
});
