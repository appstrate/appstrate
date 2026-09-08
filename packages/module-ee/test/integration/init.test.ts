import { describe, expect, it } from "bun:test";
import cloudModule, { QuotaExceededError } from "../../src/index.ts";

describe("cloud module exports", () => {
  describe("manifest", () => {
    it("has correct module metadata", () => {
      expect(cloudModule.manifest.id).toBe("cloud");
      expect(cloudModule.manifest.name).toBe("Appstrate Cloud");
      expect(cloudModule.manifest.version).toBe("0.1.0");
    });
  });

  describe("hooks", () => {
    it("has a unified beforeUsage admission gate", () => {
      expect(typeof cloudModule.hooks?.beforeUsage).toBe("function");
    });

    it("does NOT register afterRun — billing moved to the cursor sweep, not the hook", () => {
      expect(cloudModule.hooks?.afterRun).toBeUndefined();
    });

    it("does NOT register beforeSignup — domain allowlist is platform-native (AUTH_ALLOWED_SIGNUP_DOMAINS)", () => {
      expect(cloudModule.hooks?.beforeSignup).toBeUndefined();
    });
  });

  describe("emailOverrides", () => {
    it("provides branded email template overrides", () => {
      expect(cloudModule.emailOverrides).toBeDefined();
      expect(typeof cloudModule.emailOverrides?.verification).toBe("function");
      expect(typeof cloudModule.emailOverrides?.invitation).toBe("function");
      expect(typeof cloudModule.emailOverrides?.["magic-link"]).toBe("function");
      expect(typeof cloudModule.emailOverrides?.["reset-password"]).toBe("function");
    });
  });

  describe("events", () => {
    it("has onOrgCreate function", () => {
      expect(typeof cloudModule.events?.onOrgCreate).toBe("function");
    });

    it("has onOrgDelete function", () => {
      expect(typeof cloudModule.events?.onOrgDelete).toBe("function");
    });

    it("does NOT register onRunStatusChange — billing is driven by the cursor sweep, not events", () => {
      expect(cloudModule.events?.onRunStatusChange).toBeUndefined();
    });

    it("does NOT register onUsageRecorded — the cursor is authoritative, not an event consumer", () => {
      expect(cloudModule.events?.onUsageRecorded).toBeUndefined();
    });
  });

  describe("publicPaths", () => {
    it('includes "/api/billing/webhooks"', () => {
      expect(cloudModule.publicPaths).toContain("/api/billing/webhooks");
    });

    it("is an array with at least 1 entry", () => {
      expect(Array.isArray(cloudModule.publicPaths)).toBe(true);
      expect(cloudModule.publicPaths!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("QuotaExceededError", () => {
    it("is exported and can be instantiated", () => {
      const err = new QuotaExceededError("00000000-0000-4000-a000-000000000001", "budget");
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect(err.code).toBe("QUOTA_EXCEEDED");
      expect(err.name).toBe("QuotaExceededError");
    });
  });

  describe("features", () => {
    it("declares the billing and custom-roles feature flags", () => {
      // `custom_roles` licenses the platform's own `/api/roles` write routes
      // (RBAC spec §9) — the EE half of an otherwise OSS RBAC surface.
      expect(cloudModule.features).toEqual({ billing: true, custom_roles: true });
    });
  });

  describe("module initialization", () => {
    it("init was called successfully by preload (DB and Redis are available)", async () => {
      const { getCloudDb } = await import("../../src/db.ts");
      expect(() => getCloudDb()).not.toThrow();
    });

    it("Redis is initialized and reachable", async () => {
      const { getCloudRedis } = await import("../../src/redis.ts");
      const redis = getCloudRedis();
      const pong = await redis!.ping();
      expect(pong).toBe("PONG");
    });
  });
});
