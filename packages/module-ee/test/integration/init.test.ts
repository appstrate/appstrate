// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it } from "bun:test";
import eeModule, { QuotaExceededError } from "../../src/index.ts";
import { useEeTestSeams } from "../helpers/setup.ts";

useEeTestSeams();

describe("EE module exports", () => {
  describe("manifest", () => {
    it("has correct module metadata", () => {
      expect(eeModule.manifest.id).toBe("ee");
      expect(eeModule.manifest.name).toBe("Appstrate EE");
      expect(eeModule.manifest.version).toBe("0.1.0");
    });
  });

  describe("hooks", () => {
    it("has a unified beforeUsage admission gate", () => {
      expect(typeof eeModule.hooks?.beforeUsage).toBe("function");
    });
  });

  describe("emailOverrides", () => {
    it("provides branded email template overrides", () => {
      expect(eeModule.emailOverrides).toBeDefined();
      expect(typeof eeModule.emailOverrides?.verification).toBe("function");
      expect(typeof eeModule.emailOverrides?.invitation).toBe("function");
      expect(typeof eeModule.emailOverrides?.["magic-link"]).toBe("function");
      expect(typeof eeModule.emailOverrides?.["reset-password"]).toBe("function");
    });
  });

  describe("events", () => {
    it("has onOrgCreate function", () => {
      expect(typeof eeModule.events?.onOrgCreate).toBe("function");
    });

    it("has onOrgDelete function", () => {
      expect(typeof eeModule.events?.onOrgDelete).toBe("function");
    });
  });

  describe("publicPaths", () => {
    it('includes "/api/billing/webhooks"', () => {
      expect(eeModule.publicPaths).toContain("/api/billing/webhooks");
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
      expect(eeModule.features).toEqual({ billing: true, custom_roles: true });
    });
  });

  describe("module initialization", () => {
    it("init was called successfully by preload (DB and Redis are available)", async () => {
      const { getEeDb } = await import("../../src/db.ts");
      expect(() => getEeDb()).not.toThrow();
    });

    it("Redis is initialized and reachable", async () => {
      const { getEeRedis } = await import("../../src/redis.ts");
      const redis = getEeRedis();
      const pong = await redis!.ping();
      expect(pong).toBe("PONG");
    });
  });
});
