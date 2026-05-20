// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the run command's ProviderResolver builder.
 * Verifies validation + mode parsing without constructing any
 * actual HTTP client.
 */

import { describe, it, expect } from "bun:test";
import {
  buildIntegrationResolver,
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

describe("buildIntegrationResolver", () => {
  it("none → empty resolver", async () => {
    const resolver = buildIntegrationResolver("none", null);
    const tools = await resolver.resolve([], {} as Parameters<typeof resolver.resolve>[1]);
    expect(tools).toEqual([]);
  });

  it("local → throws without credsFilePath, with an integrations hint", () => {
    try {
      buildIntegrationResolver("local", null);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("--creds-file");
      expect((err as ResolverConfigError).hint).toContain("integrations");
    }
  });

  it("local → constructs lazily when credsFilePath is provided", () => {
    const resolver = buildIntegrationResolver("local", { credsFilePath: "/tmp/none.json" });
    expect(typeof resolver.resolve).toBe("function");
  });

  it("remote → throws when inputs are null", () => {
    expect(() => buildIntegrationResolver("remote", null)).toThrow(ResolverConfigError);
  });

  it("remote → throws when a required field is missing", () => {
    expect(() =>
      buildIntegrationResolver("remote", {
        instance: "https://x.com",
        bearerToken: "",
        applicationId: "app_x",
      }),
    ).toThrow(ResolverConfigError);
  });

  it("remote → throws with login hint when inputs are null", () => {
    try {
      buildIntegrationResolver("remote", null);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ResolverConfigError).hint).toContain("appstrate login");
    }
  });

  it("remote → constructs with all three fields", () => {
    const resolver = buildIntegrationResolver("remote", {
      instance: "https://x.com",
      bearerToken: "ask_x",
      applicationId: "app_x",
    });
    expect(typeof resolver.resolve).toBe("function");
  });

  it("remote → accepts a JWT bearer + optional endUserId", () => {
    const resolver = buildIntegrationResolver("remote", {
      instance: "https://x.com",
      bearerToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
      applicationId: "app_x",
      endUserId: "eu_x",
    });
    expect(typeof resolver.resolve).toBe("function");
  });
});
