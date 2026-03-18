import { describe, test, expect } from "bun:test";
import { isValidCron, computeNextRun } from "../../lib/cron.ts";

describe("cron utilities", () => {
  describe("isValidCron", () => {
    test("accepts standard 5-field cron expressions", () => {
      expect(isValidCron("* * * * *")).toBe(true);
      expect(isValidCron("0 * * * *")).toBe(true);
      expect(isValidCron("0 9 * * 1-5")).toBe(true);
      expect(isValidCron("30 2 * * *")).toBe(true);
      expect(isValidCron("0 0 1 * *")).toBe(true);
    });

    test("accepts cron with step values", () => {
      expect(isValidCron("*/5 * * * *")).toBe(true);
      expect(isValidCron("0 */2 * * *")).toBe(true);
    });

    test("accepts cron with ranges", () => {
      expect(isValidCron("0 9-17 * * *")).toBe(true);
      expect(isValidCron("0 0 * * 1-5")).toBe(true);
    });

    test("rejects invalid cron expressions", () => {
      expect(isValidCron("not-a-cron")).toBe(false);
      expect(isValidCron("60 * * * *")).toBe(false);
      expect(isValidCron("* 25 * * *")).toBe(false);
    });
  });

  describe("computeNextRun", () => {
    test("returns a future Date for valid cron", () => {
      const next = computeNextRun("* * * * *", "UTC");
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    test("respects timezone", () => {
      const next = computeNextRun("0 12 * * *", "America/New_York");
      expect(next).toBeInstanceOf(Date);
    });

    test("returns null for invalid cron", () => {
      expect(computeNextRun("invalid", "UTC")).toBeNull();
    });
  });
});
