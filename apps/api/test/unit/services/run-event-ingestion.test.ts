// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `verifyRunSignatureHeaders` and `assertSinkOpen`. These
 * are the security-critical pieces of the HMAC event-ingestion path —
 * they need to reject tampered signatures, expired sinks, and closed
 * sinks with the precise error codes documented on the public API.
 *
 * Integration coverage (replay cache, ordering buffer, DB write) lives
 * under `test/integration/routes/runs-events.test.ts`.
 */

// Env vars must be populated BEFORE any module-graph evaluation — the
// connect/encryption module reads `CONNECTION_ENCRYPTION_KEY` on first
// decrypt/encrypt call, and `@appstrate/env` validates the whole schema
// on first `getEnv()`. Set every required var before imports run.
const VALID_KEY_BASE64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
process.env.CONNECTION_ENCRYPTION_KEY = VALID_KEY_BASE64;
process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-16chars";
process.env.UPLOAD_SIGNING_SECRET = "test-upload-signing-secret-16ch";

import { describe, expect, test } from "bun:test";
import { sign } from "@appstrate/afps-runtime/events";
import { encrypt } from "@appstrate/connect";
import { ApiError } from "@appstrate/core/api-errors";
import { assertSinkOpen, verifyRunSignatureHeaders } from "../../../src/lib/run-signature.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { RunSinkContext } from "../../../src/types/run-sink.ts";

function makeRun(overrides: Partial<RunSinkContext> = {}): RunSinkContext {
  return {
    id: "run_test",
    orgId: "org_1",
    applicationId: "app_1",
    packageId: "@acme/agent",
    runOrigin: "remote",
    sinkSecretEncrypted: encrypt("s".repeat(32)),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    sinkClosedAt: null,
    lastEventSequence: 0,
    startedAt: new Date(),
    ...overrides,
  };
}

describe("verifyRunSignatureHeaders", () => {
  const secret = "s".repeat(32);
  const body = JSON.stringify({ specversion: "1.0", type: "log.written" });

  test("accepts a well-formed signed request", () => {
    const timestampSec = Math.floor(Date.now() / 1000);
    const headers = sign({ msgId: "msg_1", timestampSec, body, secret });
    const run = makeRun({ sinkSecretEncrypted: encrypt(secret) });

    expect(() =>
      verifyRunSignatureHeaders({
        run,
        body,
        signatureHeader: headers["webhook-signature"],
        msgIdHeader: headers["webhook-id"],
        timestampHeader: headers["webhook-timestamp"],
      }),
    ).not.toThrow();
  });

  test("rejects missing headers with code=missing_signature_headers", () => {
    const run = makeRun({ sinkSecretEncrypted: encrypt(secret) });
    try {
      verifyRunSignatureHeaders({
        run,
        body,
        signatureHeader: "",
        msgIdHeader: "msg_1",
        timestampHeader: "123",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("missing_signature_headers");
      expect((err as ApiError).status).toBe(401);
    }
  });

  test("rejects non-numeric timestamp with code=invalid_timestamp", () => {
    const run = makeRun({ sinkSecretEncrypted: encrypt(secret) });
    try {
      verifyRunSignatureHeaders({
        run,
        body,
        signatureHeader: "v1,abc",
        msgIdHeader: "msg_1",
        timestampHeader: "not-a-number",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("invalid_timestamp");
    }
  });

  test("rejects tampered body with code=invalid_signature", () => {
    const timestampSec = Math.floor(Date.now() / 1000);
    const signed = sign({ msgId: "msg_1", timestampSec, body, secret });
    const run = makeRun({ sinkSecretEncrypted: encrypt(secret) });

    try {
      verifyRunSignatureHeaders({
        run,
        body: body + "TAMPERED",
        signatureHeader: signed["webhook-signature"],
        msgIdHeader: signed["webhook-id"],
        timestampHeader: signed["webhook-timestamp"],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("invalid_signature");
    }
  });

  test("rejects stale timestamp with code=timestamp_out_of_tolerance", () => {
    const staleSec = Math.floor(Date.now() / 1000) - 10 * 60; // 10 min ago > 5 min tolerance
    const signed = sign({ msgId: "msg_1", timestampSec: staleSec, body, secret });
    const run = makeRun({ sinkSecretEncrypted: encrypt(secret) });

    try {
      verifyRunSignatureHeaders({
        run,
        body,
        signatureHeader: signed["webhook-signature"],
        msgIdHeader: signed["webhook-id"],
        timestampHeader: signed["webhook-timestamp"],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("timestamp_out_of_tolerance");
    }
  });

  test("rejects signature computed with the wrong secret", () => {
    const timestampSec = Math.floor(Date.now() / 1000);
    // Signer uses `otherSecret`, server stores `secret` — mismatch must fail.
    const signed = sign({
      msgId: "msg_1",
      timestampSec,
      body,
      secret: "z".repeat(32),
    });
    const run = makeRun({ sinkSecretEncrypted: encrypt(secret) });

    try {
      verifyRunSignatureHeaders({
        run,
        body,
        signatureHeader: signed["webhook-signature"],
        msgIdHeader: signed["webhook-id"],
        timestampHeader: signed["webhook-timestamp"],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("invalid_signature");
    }
  });
});

describe("assertSinkOpen", () => {
  test("passes on an open sink", () => {
    expect(() => assertSinkOpen(makeRun())).not.toThrow();
  });

  test("rejects a closed sink with code=run_sink_closed", () => {
    try {
      assertSinkOpen(makeRun({ sinkClosedAt: new Date() }));
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("run_sink_closed");
      expect((err as ApiError).status).toBe(410);
    }
  });

  test("rejects an expired sink with code=run_sink_expired", () => {
    try {
      assertSinkOpen(makeRun({ sinkExpiresAt: new Date(Date.now() - 1000) }));
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("run_sink_expired");
    }
  });

  test("closed takes precedence over expired (operator clarity)", () => {
    // If both are set, `closed` is the authoritative reason — the sink
    // was explicitly closed, expiry is then moot.
    try {
      assertSinkOpen(
        makeRun({
          sinkClosedAt: new Date(),
          sinkExpiresAt: new Date(Date.now() - 1000),
        }),
      );
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe("run_sink_closed");
    }
  });
});

describe("mintSinkCredentials", () => {
  test("returns absolute URLs derived from appUrl + runId", () => {
    const creds = mintSinkCredentials({
      runId: "run_abc",
      appUrl: "https://app.example.com",
      ttlSeconds: 3600,
    });
    expect(creds.url).toBe("https://app.example.com/api/runs/run_abc/events");
    expect(creds.finalizeUrl).toBe("https://app.example.com/api/runs/run_abc/events/finalize");
  });

  test("strips a trailing slash from appUrl (idempotent join)", () => {
    const creds = mintSinkCredentials({
      runId: "run_abc",
      appUrl: "https://app.example.com/",
      ttlSeconds: 60,
    });
    expect(creds.url).toBe("https://app.example.com/api/runs/run_abc/events");
  });

  test("mints a base64url secret of 32 bytes of entropy", () => {
    const a = mintSinkCredentials({ runId: "r", appUrl: "http://x", ttlSeconds: 60 });
    const b = mintSinkCredentials({ runId: "r", appUrl: "http://x", ttlSeconds: 60 });
    // base64url for 32 random bytes is 43 chars (no padding).
    expect(a.secret.length).toBe(43);
    expect(b.secret.length).toBe(43);
    expect(a.secret).not.toBe(b.secret);
    // Valid base64url alphabet only.
    expect(a.secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("expiresAt is approximately now + ttlSeconds (±1s)", () => {
    const ttl = 1800;
    const before = Date.now();
    const creds = mintSinkCredentials({ runId: "r", appUrl: "http://x", ttlSeconds: ttl });
    const after = Date.now();
    const exp = Date.parse(creds.expiresAt);
    expect(exp).toBeGreaterThanOrEqual(before + ttl * 1000 - 100);
    expect(exp).toBeLessThanOrEqual(after + ttl * 1000 + 100);
  });
});
