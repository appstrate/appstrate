// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { getClientIpFromRequest, resetClientIpCache } from "../../../src/lib/client-ip.ts";

const SNAPSHOT_TRUST_PROXY = process.env.TRUST_PROXY;

function setTrustProxy(v: string | undefined) {
  if (v === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = v;
  _resetCacheForTesting();
  resetClientIpCache();
}

beforeEach(() => {
  setTrustProxy("false");
});

afterAll(() => {
  if (SNAPSHOT_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = SNAPSHOT_TRUST_PROXY;
  _resetCacheForTesting();
  resetClientIpCache();
});

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/test", { headers });
}

describe("getClientIpFromRequest — TRUST_PROXY=false (default)", () => {
  it("ignores X-Forwarded-For spoofing — returns null", () => {
    const req = requestWith({ "x-forwarded-for": "1.2.3.4" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("ignores X-Real-IP spoofing", () => {
    const req = requestWith({ "x-real-ip": "1.2.3.4" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("returns null when request is undefined", () => {
    expect(getClientIpFromRequest(undefined)).toBeNull();
  });
});

describe("getClientIpFromRequest — TRUST_PROXY=true (1 hop)", () => {
  beforeEach(() => {
    setTrustProxy("true");
  });

  it("takes the rightmost XFF entry", () => {
    const req = requestWith({ "x-forwarded-for": "client, proxy1, proxy2" });
    expect(getClientIpFromRequest(req)).toBe("proxy2");
  });

  it("single XFF entry: returns it", () => {
    const req = requestWith({ "x-forwarded-for": "1.2.3.4" });
    expect(getClientIpFromRequest(req)).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP when XFF is absent", () => {
    const req = requestWith({ "x-real-ip": "5.6.7.8" });
    expect(getClientIpFromRequest(req)).toBe("5.6.7.8");
  });
});

describe("getClientIpFromRequest — TRUST_PROXY=2 (2 trusted hops)", () => {
  beforeEach(() => {
    setTrustProxy("2");
  });

  it("takes the XFF entry 2 positions from the right", () => {
    const req = requestWith({ "x-forwarded-for": "client, proxy1, proxy2" });
    expect(getClientIpFromRequest(req)).toBe("proxy1");
  });

  it("clamps to leftmost when not enough entries", () => {
    const req = requestWith({ "x-forwarded-for": "client" });
    expect(getClientIpFromRequest(req)).toBe("client");
  });
});
