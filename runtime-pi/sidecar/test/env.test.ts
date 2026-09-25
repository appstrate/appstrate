// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseSidecarEnv, SidecarEnvError } from "../env.ts";

const VALID = {
  PLATFORM_API_URL: "http://host.docker.internal:3000",
  RUN_TOKEN: "run-token",
  PORT: "8080",
  FORWARD_PROXY_PORT: "8081",
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
      forwardProxyPort: 8081,
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
      "FORWARD_PROXY_PORT: required",
    ]);
    expect(issuesOf({ ...VALID, RUN_TOKEN: "" })).toEqual(["RUN_TOKEN: required"]);
  });

  it("rejects a non-http PLATFORM_API_URL and an out-of-range port", () => {
    expect(issuesOf({ ...VALID, PLATFORM_API_URL: "localhost:3000" })[0]).toStartWith(
      "PLATFORM_API_URL: must be an http(s) URL",
    );
    for (const bad of ["0", "abc", "65536", "80.5"]) {
      expect(issuesOf({ ...VALID, PORT: bad })[0]).toStartWith("PORT:");
      expect(issuesOf({ ...VALID, FORWARD_PROXY_PORT: bad })[0]).toStartWith("FORWARD_PROXY_PORT:");
    }
  });

  it("takes the forward proxy port as given — not adjacent to PORT, but never equal", () => {
    expect(parseSidecarEnv({ ...VALID, PORT: "41000", FORWARD_PROXY_PORT: "52313" })).toMatchObject(
      { port: 41000, forwardProxyPort: 52313 },
    );
    expect(issuesOf({ ...VALID, FORWARD_PROXY_PORT: "8080" })).toEqual([
      'FORWARD_PROXY_PORT: must differ from PORT (both "8080")',
    ]);
  });

  it("renders a single-line message (connect mode relays it on one stdout sentinel)", () => {
    expect.assertions(1);
    try {
      parseSidecarEnv({});
    } catch (err) {
      expect((err as Error).message).not.toContain("\n");
    }
  });
});
