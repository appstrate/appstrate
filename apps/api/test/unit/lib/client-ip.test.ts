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
    const req = requestWith({ "x-forwarded-for": "203.0.113.9, 198.51.100.7, 192.0.2.5" });
    expect(getClientIpFromRequest(req)).toBe("192.0.2.5");
  });

  it("ignores an attacker prefix — the entry our own proxy appended wins", () => {
    const req = requestWith({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" });
    expect(getClientIpFromRequest(req)).toBe("198.51.100.7");
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
    const req = requestWith({ "x-forwarded-for": "203.0.113.9, 198.51.100.7, 192.0.2.5" });
    expect(getClientIpFromRequest(req)).toBe("198.51.100.7");
  });
});

// #1316 — a chain SHORTER than the trusted hop count did not pass through the
// hops we trust, so every entry in it is caller-supplied. The resolver must
// distrust the whole forwarded set there and let the caller fall back to the
// socket peer (`null` here, since no middleware stored one), never clamp to
// the leftmost entry: clamping handed any caller a chosen IP under any
// `TRUST_PROXY >= 1` and defeated every per-IP rate limit.
describe("getClientIpFromRequest — forwarded chain shorter than the hop count", () => {
  it("TRUST_PROXY=2, one entry: distrusts the chain", () => {
    setTrustProxy("2");
    const req = requestWith({ "x-forwarded-for": "203.0.113.9" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("TRUST_PROXY=3, two entries: distrusts the chain", () => {
    setTrustProxy("3");
    const req = requestWith({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("does not fall through to X-Real-IP — that would reopen the hole", () => {
    setTrustProxy("2");
    const req = requestWith({
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.99",
    });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("an empty chain is a short chain", () => {
    setTrustProxy("true");
    const req = requestWith({ "x-forwarded-for": "  ,  " });
    expect(getClientIpFromRequest(req)).toBeNull();
  });
});

// #1316 sub-defect — an entry that is not an IP address must not be stamped:
// Better Auth's `getIP` drops every unparseable address into ONE shared
// rate-limit bucket, so one caller sending junk would limit the whole
// instance. Port suffixes and bracketed IPv6 are spellings of a real address
// and normalize to it.
describe("getClientIpFromRequest — the resolved value must be an IP address", () => {
  beforeEach(() => {
    setTrustProxy("true");
  });

  it("rejects a non-IP XFF entry", () => {
    const req = requestWith({ "x-forwarded-for": "not-an-ip" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("rejects a non-IP X-Real-IP", () => {
    const req = requestWith({ "x-real-ip": "evil.example.com" });
    expect(getClientIpFromRequest(req)).toBeNull();
  });

  it("strips an IPv4 port suffix", () => {
    const req = requestWith({ "x-forwarded-for": "203.0.113.9:52000" });
    expect(getClientIpFromRequest(req)).toBe("203.0.113.9");
  });

  it("accepts a bare IPv6 entry", () => {
    const req = requestWith({ "x-forwarded-for": "2001:db8::1" });
    expect(getClientIpFromRequest(req)).toBe("2001:db8::1");
  });

  it("strips IPv6 brackets and port", () => {
    const req = requestWith({ "x-forwarded-for": "[2001:db8::1]:443" });
    expect(getClientIpFromRequest(req)).toBe("2001:db8::1");
  });
});
