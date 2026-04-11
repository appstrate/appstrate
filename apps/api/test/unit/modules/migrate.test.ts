import { describe, it, expect } from "bun:test";
import { lockKeyForModule } from "../../../src/lib/modules/migrate.ts";

describe("lockKeyForModule", () => {
  it("is deterministic for the same input", () => {
    const a = lockKeyForModule("__drizzle_migrations_webhooks");
    const b = lockKeyForModule("__drizzle_migrations_webhooks");
    expect(a).toBe(b);
  });

  it("distinguishes different module tables", () => {
    const webhooks = lockKeyForModule("__drizzle_migrations_webhooks");
    const providerMgmt = lockKeyForModule("__drizzle_migrations_provider_management");
    expect(webhooks).not.toBe(providerMgmt);
  });

  it("returns a bigint within signed 64-bit range", () => {
    const key = lockKeyForModule("__drizzle_migrations_webhooks");
    expect(typeof key).toBe("bigint");
    expect(key >= -0x8000000000000000n).toBe(true);
    expect(key <= 0x7fffffffffffffffn).toBe(true);
  });

  it("handles empty input without throwing", () => {
    const key = lockKeyForModule("");
    expect(typeof key).toBe("bigint");
  });
});
