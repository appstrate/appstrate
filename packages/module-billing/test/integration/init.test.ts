// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import billingModule, { QuotaExceededError } from "../../src/index.ts";
import { useBillingTestSeams } from "../helpers/setup.ts";

useBillingTestSeams();

describe("billing module exports", () => {
  describe("manifest", () => {
    it("has correct module metadata", () => {
      expect(billingModule.manifest.id).toBe("billing");
      expect(billingModule.manifest.name).toBe("Appstrate Billing");
      expect(billingModule.manifest.version).toBe("0.1.0");
    });
  });

  describe("hooks", () => {
    it("has a unified beforeUsage admission gate", () => {
      expect(typeof billingModule.hooks?.beforeUsage).toBe("function");
    });
  });

  describe("emailOverrides", () => {
    it("provides branded email template overrides", () => {
      expect(billingModule.emailOverrides).toBeDefined();
      expect(typeof billingModule.emailOverrides?.verification).toBe("function");
      expect(typeof billingModule.emailOverrides?.invitation).toBe("function");
      expect(typeof billingModule.emailOverrides?.["magic-link"]).toBe("function");
      expect(typeof billingModule.emailOverrides?.["reset-password"]).toBe("function");
    });
  });

  describe("events", () => {
    it("has onOrgCreate function", () => {
      expect(typeof billingModule.events?.onOrgCreate).toBe("function");
    });

    it("has onOrgDelete function", () => {
      expect(typeof billingModule.events?.onOrgDelete).toBe("function");
    });

    it("has onOrgMemberRemove function", () => {
      expect(typeof billingModule.events?.onOrgMemberRemove).toBe("function");
    });
  });

  describe("publicPaths", () => {
    it('includes "/api/billing/webhooks"', () => {
      expect(billingModule.publicPaths).toContain("/api/billing/webhooks");
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
    it("declares `billing` and nothing else", () => {
      // `toEqual` on the WHOLE object, not a `billing` lookup: the point of the
      // assertion is the absence. Custom space roles are platform code behind
      // no flag (RBAC spec §9): a licence flag over platform-owned routes is
      // what this keeps out.
      expect(billingModule.features).toEqual({ billing: true });
    });
  });

  describe("module initialization", () => {
    it("init was called successfully by preload (DB and Redis are available)", async () => {
      const { getBillingDb } = await import("../../src/db.ts");
      expect(() => getBillingDb()).not.toThrow();
    });

    it("Redis is initialized and reachable", async () => {
      const { getBillingRedis } = await import("../../src/redis.ts");
      const redis = getBillingRedis();
      const pong = await redis!.ping();
      expect(pong).toBe("PONG");
    });
  });
});
