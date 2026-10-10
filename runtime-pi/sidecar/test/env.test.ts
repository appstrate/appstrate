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
      listenHost: "0.0.0.0",
      runtimeToolNames: [],
    });
  });

  it("parses the run's runtime tools and output schema", () => {
    const env = parseSidecarEnv({
      ...VALID,
      RUNTIME_TOOLS_JSON: '["output","note"]',
      OUTPUT_SCHEMA: '{"type":"object"}',
    });
    expect(env.runtimeToolNames).toEqual(["output", "note"]);
    expect(env.outputSchema).toEqual({ type: "object" });
  });

  it("fails on a malformed runtime-tool list or output schema instead of dropping it", () => {
    expect(issuesOf({ ...VALID, RUNTIME_TOOLS_JSON: "[output" })).toEqual([
      "RUNTIME_TOOLS_JSON: must be valid JSON",
    ]);
    expect(issuesOf({ ...VALID, RUNTIME_TOOLS_JSON: '["output",1]' })).toEqual([
      "RUNTIME_TOOLS_JSON: unexpected shape",
    ]);
    expect(issuesOf({ ...VALID, OUTPUT_SCHEMA: "[]" })).toEqual([
      "OUTPUT_SCHEMA: unexpected shape",
    ]);
  });

  it("requires a 32-byte CONNECT_RESULT_KEY in connect mode, and only there", () => {
    const connect = { ...VALID, CONNECT_LOGIN_JSON: "{}" };
    expect(issuesOf(connect)).toEqual(["CONNECT_RESULT_KEY: required in connect mode"]);
    expect(
      issuesOf({ ...connect, CONNECT_RESULT_KEY: Buffer.alloc(16).toString("base64") }),
    ).toEqual(["CONNECT_RESULT_KEY: must decode to 32 bytes (AES-256 key)"]);
    const key = Buffer.alloc(32, 7);
    const env = parseSidecarEnv({ ...connect, CONNECT_RESULT_KEY: key.toString("base64") });
    expect(env.connectResultKey).toEqual(key);
    expect(parseSidecarEnv({ ...VALID, CONNECT_RESULT_KEY: "x" }).connectResultKey).toBeUndefined();
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

  it("binds every interface unless LISTEN_HOST names one IP address", () => {
    expect(parseSidecarEnv(VALID).listenHost).toBe("0.0.0.0");
    expect(parseSidecarEnv({ ...VALID, LISTEN_HOST: "127.0.0.1" }).listenHost).toBe("127.0.0.1");
    expect(issuesOf({ ...VALID, LISTEN_HOST: "localhost" })).toEqual([
      'LISTEN_HOST: must be an IP address (got "localhost")',
    ]);
  });

  it("takes the forward proxy port as given — not adjacent to PORT, but never equal", () => {
    expect(parseSidecarEnv({ ...VALID, PORT: "41000", FORWARD_PROXY_PORT: "52313" })).toMatchObject(
      { port: 41000, forwardProxyPort: 52313 },
    );
    expect(issuesOf({ ...VALID, FORWARD_PROXY_PORT: "8080" })).toEqual([
      'FORWARD_PROXY_PORT: must differ from PORT (both "8080")',
    ]);
  });

  it("refuses a malformed EGRESS_ALLOW_INTERNAL_HOSTS entry at boot, naming the entry", () => {
    expect(issuesOf({ ...VALID, EGRESS_ALLOW_INTERNAL_HOSTS: "a.internal,b.internal:80" })).toEqual(
      [
        'EGRESS_ALLOW_INTERNAL_HOSTS: "b.internal:80" is not a bare hostname or dotted IPv4 address (e.g. "keycloak.internal", "10.0.0.5"; no scheme, port, path, wildcard, IPv6 literal or trailing dot; IDN hosts in punycode)',
      ],
    );
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
