// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { sign, verify } from "../../src/events/signing.ts";

describe("signing", () => {
  describe("sign", () => {
    it("produces Standard Webhooks-shaped headers", () => {
      const headers = sign({
        msgId: "msg_1",
        timestampSec: 1714000000,
        body: '{"hello":"world"}',
        secret: "super-secret",
      });
      expect(headers["webhook-id"]).toBe("msg_1");
      expect(headers["webhook-timestamp"]).toBe("1714000000");
      expect(headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    });

    it("signature matches an independent HMAC-SHA256 computation", () => {
      const opts = {
        msgId: "msg_xyz",
        timestampSec: 1700000000,
        body: '{"a":1}',
        secret: "k",
      };
      const headers = sign(opts);
      const independent = createHmac("sha256", opts.secret)
        .update(`${opts.msgId}.${opts.timestampSec}.${opts.body}`)
        .digest("base64");
      expect(headers["webhook-signature"]).toBe(`v1,${independent}`);
    });

    it("different body → different signature", () => {
      const base = { msgId: "m", timestampSec: 1, secret: "s" };
      const a = sign({ ...base, body: "a" });
      const b = sign({ ...base, body: "b" });
      expect(a["webhook-signature"]).not.toBe(b["webhook-signature"]);
    });

    it("different secret → different signature", () => {
      const base = { msgId: "m", timestampSec: 1, body: "x" };
      const a = sign({ ...base, secret: "s1" });
      const b = sign({ ...base, secret: "s2" });
      expect(a["webhook-signature"]).not.toBe(b["webhook-signature"]);
    });
  });

  describe("verify", () => {
    it("round-trips a valid signature", () => {
      const opts = {
        msgId: "m1",
        timestampSec: 1714000000,
        body: '{"x":1}',
        secret: "k",
      };
      const { "webhook-signature": sig } = sign(opts);
      const result = verify({
        ...opts,
        signatureHeader: sig,
        nowSec: opts.timestampSec,
      });
      expect(result).toEqual({ ok: true });
    });

    it("rejects a tampered body", () => {
      const opts = {
        msgId: "m1",
        timestampSec: 1,
        body: "original",
        secret: "k",
      };
      const { "webhook-signature": sig } = sign(opts);
      const result = verify({
        ...opts,
        body: "tampered",
        signatureHeader: sig,
        nowSec: opts.timestampSec,
      });
      expect(result).toEqual({ ok: false, reason: "no_valid_signature" });
    });

    it("rejects when the timestamp drifts past tolerance", () => {
      const opts = {
        msgId: "m1",
        timestampSec: 1000,
        body: "b",
        secret: "k",
      };
      const { "webhook-signature": sig } = sign(opts);
      const result = verify({
        ...opts,
        signatureHeader: sig,
        nowSec: opts.timestampSec + 600, // 10 min drift, default tolerance 5 min
      });
      expect(result).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
    });

    it("accepts a signature list (rotation window)", () => {
      const opts = {
        msgId: "m1",
        timestampSec: 1,
        body: "b",
        secret: "new-secret",
      };
      const { "webhook-signature": validSig } = sign(opts);
      const fakeOldSig = "v1,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
      const result = verify({
        ...opts,
        signatureHeader: `${fakeOldSig} ${validSig}`,
        nowSec: opts.timestampSec,
      });
      expect(result).toEqual({ ok: true });
    });

    it("ignores unknown signature versions", () => {
      const opts = {
        msgId: "m1",
        timestampSec: 1,
        body: "b",
        secret: "k",
      };
      const { "webhook-signature": validV1 } = sign(opts);
      const result = verify({
        ...opts,
        signatureHeader: `v2,someFuturistSig=== ${validV1}`,
        nowSec: opts.timestampSec,
      });
      expect(result).toEqual({ ok: true });
    });

    it("rejects an empty signature header", () => {
      const result = verify({
        msgId: "m1",
        timestampSec: 1,
        body: "b",
        secret: "k",
        signatureHeader: "",
        nowSec: 1,
      });
      expect(result).toEqual({ ok: false, reason: "malformed_signature_header" });
    });
  });
});
