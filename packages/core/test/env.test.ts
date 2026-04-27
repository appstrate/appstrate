// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { createEnvGetter } from "../src/env.ts";

describe("createEnvGetter", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses environment variables with a Zod schema", () => {
    process.env.TEST_VAR = "hello";
    const schema = z.object({
      TEST_VAR: z.string().min(1),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(getEnv().TEST_VAR).toBe("hello");
  });

  it("throws on invalid environment variables", () => {
    delete process.env.REQUIRED_VAR;
    const schema = z.object({
      REQUIRED_VAR: z.string().min(1, "REQUIRED_VAR is required"),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(() => getEnv()).toThrow("[env] Invalid environment variables:");
  });

  it("caches the result after first call", () => {
    process.env.CACHED_VAR = "first";
    const schema = z.object({
      CACHED_VAR: z.string(),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(getEnv().CACHED_VAR).toBe("first");

    // Change env var — should still return cached value
    process.env.CACHED_VAR = "second";
    expect(getEnv().CACHED_VAR).toBe("first");
  });

  it("resetCache forces re-parsing", () => {
    process.env.RESET_VAR = "initial";
    const schema = z.object({
      RESET_VAR: z.string(),
    });
    const { getEnv, resetCache } = createEnvGetter(schema);
    expect(getEnv().RESET_VAR).toBe("initial");

    process.env.RESET_VAR = "updated";
    resetCache();
    expect(getEnv().RESET_VAR).toBe("updated");
  });

  it("supports default values in schema", () => {
    const schema = z.object({
      WITH_DEFAULT: z.string().default("fallback"),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(getEnv().WITH_DEFAULT).toBe("fallback");
  });

  describe("empty-string sanitization (compose `${VAR:-}` pattern)", () => {
    it("treats empty string as unset so `.default()` fires", () => {
      process.env.WITH_DEFAULT = "";
      const schema = z.object({
        WITH_DEFAULT: z.string().default("fallback"),
      });
      const { getEnv } = createEnvGetter(schema);
      expect(getEnv().WITH_DEFAULT).toBe("fallback");
    });

    it("treats empty string as unset for refined-string fields", () => {
      process.env.MODE = "";
      const schema = z.object({
        MODE: z
          .string()
          .default("auto")
          .refine((v) => v === "auto" || v === "manual", {
            message: "MODE must be 'auto' or 'manual'",
          }),
      });
      const { getEnv } = createEnvGetter(schema);
      expect(getEnv().MODE).toBe("auto");
    });

    it("treats empty string as unset for enum fields", () => {
      process.env.LOG_LEVEL = "";
      const schema = z.object({
        LOG_LEVEL: z.enum(["debug", "info", "warn"]).default("info"),
      });
      const { getEnv } = createEnvGetter(schema);
      expect(getEnv().LOG_LEVEL).toBe("info");
    });

    it("makes empty string indistinguishable from unset for `.optional()`", () => {
      process.env.OPTIONAL_VAR = "";
      const schema = z.object({
        OPTIONAL_VAR: z.string().optional(),
      });
      const { getEnv } = createEnvGetter(schema);
      expect(getEnv().OPTIONAL_VAR).toBeUndefined();
    });

    it("preserves non-empty values verbatim", () => {
      process.env.NAMED_VAR = "actual-value";
      const schema = z.object({
        NAMED_VAR: z.string().default("fallback"),
      });
      const { getEnv } = createEnvGetter(schema);
      expect(getEnv().NAMED_VAR).toBe("actual-value");
    });
  });
});
