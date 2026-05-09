// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the run command's ProviderResolver builder.
 * Verifies validation + mode parsing without constructing any
 * actual HTTP client.
 */

import { describe, it, expect } from "bun:test";
import {
  buildResolver,
  parseProviderMode,
  ResolverConfigError,
} from "../src/commands/run/resolver.ts";

describe("parseProviderMode", () => {
  it("defaults to remote when nothing is passed", () => {
    expect(parseProviderMode(undefined)).toBe("remote");
  });

  it("accepts remote | local | none verbatim", () => {
    expect(parseProviderMode("remote")).toBe("remote");
    expect(parseProviderMode("local")).toBe("local");
    expect(parseProviderMode("none")).toBe("none");
  });

  it("throws ResolverConfigError on invalid input", () => {
    expect(() => parseProviderMode("cloud")).toThrow(ResolverConfigError);
  });

  it("error lists accepted modes", () => {
    try {
      parseProviderMode("cloud");
    } catch (err) {
      expect((err as ResolverConfigError).hint).toContain("remote");
      expect((err as ResolverConfigError).hint).toContain("local");
      expect((err as ResolverConfigError).hint).toContain("none");
    }
  });
});

describe("buildResolver — none", () => {
  it("returns an empty resolver that produces no tools", async () => {
    const resolver = buildResolver("none", null);
    const tools = await resolver.resolve([], {} as Parameters<typeof resolver.resolve>[1]);
    expect(tools).toEqual([]);
  });
});

describe("buildResolver — local", () => {
  it("throws when credsFilePath is missing", () => {
    expect(() => buildResolver("local", null)).toThrow(ResolverConfigError);
  });

  it("throws with hint when credsFilePath is missing", () => {
    try {
      buildResolver("local", null);
    } catch (err) {
      // message names the missing flag; hint documents the file format.
      expect((err as Error).message).toContain("--creds-file");
      expect((err as ResolverConfigError).hint).toContain("providers");
    }
  });

  it("constructs a resolver when credsFilePath is provided", () => {
    // The resolver is lazy — no file IO happens until resolve() is called.
    const resolver = buildResolver("local", { credsFilePath: "/tmp/nonexistent.json" });
    expect(typeof resolver.resolve).toBe("function");
  });
});

describe("buildResolver — remote", () => {
  it("throws when inputs are null", () => {
    expect(() => buildResolver("remote", null)).toThrow(ResolverConfigError);
  });

  it("throws with login hint when inputs are null", () => {
    try {
      buildResolver("remote", null);
    } catch (err) {
      expect((err as ResolverConfigError).hint).toContain("appstrate login");
    }
  });

  it("throws when any required field is missing", () => {
    expect(() =>
      buildResolver("remote", {
        instance: "",
        bearerToken: "ask_x",
        applicationId: "app_x",
      }),
    ).toThrow(ResolverConfigError);
    expect(() =>
      buildResolver("remote", {
        instance: "https://x.com",
        bearerToken: "",
        applicationId: "app_x",
      }),
    ).toThrow(ResolverConfigError);
    expect(() =>
      buildResolver("remote", {
        instance: "https://x.com",
        bearerToken: "ask_x",
        applicationId: "",
      }),
    ).toThrow(ResolverConfigError);
  });

  it("constructs a resolver with all three fields", () => {
    const resolver = buildResolver("remote", {
      instance: "https://x.com",
      bearerToken: "ask_x",
      applicationId: "app_x",
    });
    expect(typeof resolver.resolve).toBe("function");
  });

  it("accepts a JWT bearer alongside the ask_… shape", () => {
    const resolver = buildResolver("remote", {
      instance: "https://x.com",
      bearerToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
      applicationId: "app_x",
    });
    expect(typeof resolver.resolve).toBe("function");
  });

  it("accepts optional endUserId", () => {
    const resolver = buildResolver("remote", {
      instance: "https://x.com",
      bearerToken: "ask_x",
      applicationId: "app_x",
      endUserId: "eu_x",
    });
    expect(typeof resolver.resolve).toBe("function");
  });
});
