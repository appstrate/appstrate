// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for credential-proxy session binding.
 *
 * The helper depends on the shared `getCache()` singleton. In unit tests
 * (REDIS_URL absent) it falls back to the in-memory `LocalCache`, which
 * gives us real NX semantics and TTL expiry without mocking.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  isValidSessionId,
  bindOrCheckSession,
} from "../../src/services/credential-proxy/session.ts";
import { getCache } from "../../src/infra/index.ts";

async function resetCache(): Promise<void> {
  // Wipe any cp:session:* keys we might have left. LocalCache doesn't
  // expose iteration, so we just clear keys used by the current suite.
  const cache = await getCache();
  // Best-effort — tests always pick fresh UUIDs anyway.
  await cache.del("cp:session:deadbeef-dead-4bef-8bef-feedfacebead");
}

function freshV4(): string {
  // Bun provides crypto.randomUUID which is v4.
  return crypto.randomUUID();
}

describe("isValidSessionId", () => {
  it("accepts a fresh crypto.randomUUID", () => {
    expect(isValidSessionId(crypto.randomUUID())).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidSessionId("")).toBe(false);
  });

  it("rejects non-UUID strings", () => {
    expect(isValidSessionId("not-a-uuid")).toBe(false);
    expect(isValidSessionId("12345")).toBe(false);
    expect(isValidSessionId("abcdefgh")).toBe(false);
  });

  it("rejects UUID v1 (time-based)", () => {
    // v1 UUID: the 13th char is '1' (version), not '4'
    expect(isValidSessionId("550e8400-e29b-11d4-a716-446655440000")).toBe(false);
  });

  it("rejects UUID v4 with wrong variant bits", () => {
    // 17th char must be 8/9/a/b — use '0' to force invalid variant
    expect(isValidSessionId("550e8400-e29b-41d4-0716-446655440000")).toBe(false);
  });

  it("accepts UUID v4 regardless of case", () => {
    const id = crypto.randomUUID();
    expect(isValidSessionId(id.toUpperCase())).toBe(true);
  });

  it("rejects extra whitespace / trailing content", () => {
    const id = crypto.randomUUID();
    expect(isValidSessionId(` ${id}`)).toBe(false);
    expect(isValidSessionId(`${id}x`)).toBe(false);
  });
});

describe("bindOrCheckSession", () => {
  beforeEach(async () => {
    await resetCache();
  });

  it("binds a fresh session to the caller's API key", async () => {
    const sessionId = freshV4();
    const result = await bindOrCheckSession(sessionId, "ask_1", 60);
    expect(result.kind).toBe("bound");
  });

  it("reports reused when same API key re-uses the session", async () => {
    const sessionId = freshV4();
    await bindOrCheckSession(sessionId, "ask_1", 60);
    const second = await bindOrCheckSession(sessionId, "ask_1", 60);
    expect(second.kind).toBe("reused");
  });

  it("reports mismatch when a different API key tries to use an existing session", async () => {
    const sessionId = freshV4();
    await bindOrCheckSession(sessionId, "ask_1", 60);
    const second = await bindOrCheckSession(sessionId, "ask_2", 60);
    expect(second.kind).toBe("mismatch");
    if (second.kind === "mismatch") {
      expect(second.boundTo).toBe("ask_1");
    }
  });

  it("ttl expiry releases the binding", async () => {
    const sessionId = freshV4();
    // 1-second TTL
    await bindOrCheckSession(sessionId, "ask_1", 1);
    // Wait past expiry (LocalCache purges on read)
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const after = await bindOrCheckSession(sessionId, "ask_2", 60);
    // After expiry, ask_2 should now be able to bind.
    expect(after.kind).toBe("bound");
  });
});
