// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseSidecarEnv, SidecarEnvError } from "../env.ts";

const VALID = {
  PLATFORM_API_URL: "http://host.docker.internal:3000",
  RUN_TOKEN: "run-token",
  PORT: "8080",
};

function issuesOf(source: Record<string, string>): ReadonlyArray<string> {
  try {
    parseSidecarEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(SidecarEnvError);
    return (err as SidecarEnvError).issues;
  }
  throw new Error("expected parseSidecarEnv to throw");
}

describe("parseSidecarEnv", () => {
  it("parses the base block every orchestrator writes", () => {
    expect(parseSidecarEnv(VALID)).toEqual({
      platformApiUrl: VALID.PLATFORM_API_URL,
      runToken: "run-token",
      port: 8080,
    });
  });

  it("keeps the optional values optional, empty meaning absent", () => {
    expect(parseSidecarEnv({ ...VALID, SIDECAR_AUTH_TOKEN: "", PROXY_URL: "" })).toEqual(
      parseSidecarEnv(VALID),
    );
    const env = parseSidecarEnv({
      ...VALID,
      SIDECAR_AUTH_TOKEN: "sat",
      PROXY_URL: "http://proxy:3128",
    });
    expect(env.sidecarAuthToken).toBe("sat");
    expect(env.proxyUrl).toBe("http://proxy:3128");
  });

  it("fails on every missing required var at once — no localhost / empty-token default", () => {
    expect(issuesOf({})).toEqual([
      "PLATFORM_API_URL: required",
      "RUN_TOKEN: required",
      "PORT: required",
    ]);
    expect(issuesOf({ ...VALID, RUN_TOKEN: "" })).toEqual(["RUN_TOKEN: required"]);
  });

  it("rejects a non-http PLATFORM_API_URL and an out-of-range PORT", () => {
    expect(issuesOf({ ...VALID, PLATFORM_API_URL: "localhost:3000" })[0]).toStartWith(
      "PLATFORM_API_URL: must be an http(s) URL",
    );
    for (const bad of ["0", "abc", "65535", "80.5"]) {
      expect(issuesOf({ ...VALID, PORT: bad })[0]).toStartWith("PORT:");
    }
  });

  it("renders a single-line message (connect mode relays it on one stdout sentinel)", () => {
    try {
      parseSidecarEnv({});
    } catch (err) {
      expect((err as Error).message).not.toContain("\n");
    }
  });
});
