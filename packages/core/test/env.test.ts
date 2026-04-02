// SPDX-License-Identifier: Apache-2.0

import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import { createEnvGetter } from "../src/env.ts";

describe("createEnvGetter", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("parses environment variables with a Zod schema", () => {
    process.env.TEST_VAR = "hello";
    const schema = z.object({
      TEST_VAR: z.string().min(1),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(getEnv().TEST_VAR).toBe("hello");
  });

  test("throws on invalid environment variables", () => {
    delete process.env.REQUIRED_VAR;
    const schema = z.object({
      REQUIRED_VAR: z.string().min(1, "REQUIRED_VAR is required"),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(() => getEnv()).toThrow("[env] Invalid environment variables:");
  });

  test("caches the result after first call", () => {
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

  test("resetCache forces re-parsing", () => {
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

  test("supports default values in schema", () => {
    const schema = z.object({
      WITH_DEFAULT: z.string().default("fallback"),
    });
    const { getEnv } = createEnvGetter(schema);
    expect(getEnv().WITH_DEFAULT).toBe("fallback");
  });
});
