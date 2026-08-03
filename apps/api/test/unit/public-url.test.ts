// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { getClientIpFromRequest, setRequestClientIp } from "../../src/lib/client-ip.ts";
import { withPublicAppOrigin } from "../../src/lib/public-url.ts";

describe("withPublicAppOrigin", () => {
  let savedAppUrl: string | undefined;

  beforeEach(() => {
    savedAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://app.example.test";
    _resetCacheForTesting();
  });

  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
    _resetCacheForTesting();
  });

  it("re-homes an internal request without changing its HTTP semantics", async () => {
    const request = new Request("http://app:3000/api/auth/oauth2/token?resource=urn%3Aexample", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Trace": "trace-1" },
      body: '{"grant_type":"authorization_code"}',
    });

    const canonical = withPublicAppOrigin(request);

    expect(canonical.url).toBe(
      "https://app.example.test/api/auth/oauth2/token?resource=urn%3Aexample",
    );
    expect(canonical.method).toBe("POST");
    expect(canonical.headers.get("X-Trace")).toBe("trace-1");
    expect(await canonical.text()).toBe('{"grant_type":"authorization_code"}');
  });

  it("preserves client-IP metadata used by Better Auth rate limiters", () => {
    const request = new Request("http://app:3000/api/auth/sign-in/email", { method: "POST" });
    setRequestClientIp(request, "192.0.2.42");

    const canonical = withPublicAppOrigin(request);

    expect(getClientIpFromRequest(canonical)).toBe("192.0.2.42");
  });
});
