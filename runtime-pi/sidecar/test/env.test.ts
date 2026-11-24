// SPDX-License-Identifier: Apache-2.0

import { readConnectSpec, readIntegrationSpecsFromEnv } from "../integrations-boot.ts";
import { describe, it, expect, expectTypeOf } from "bun:test";
import type {
  integrationSpawnSpecSchema,
  IntegrationSpawnSpec,
} from "@appstrate/core/sidecar-types";
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
    });
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

describe("integration launch declarations", () => {
  it("keeps every schema field, including optional nested fields, aligned with the published interface", () => {
    type WritableWire<T> = T extends readonly (infer Item)[]
      ? WritableWire<Item>[]
      : T extends object
        ? { -readonly [K in keyof T]: WritableWire<T[K]> }
        : T;
    expectTypeOf<WritableWire<ReturnType<typeof integrationSpawnSpecSchema.parse>>>().toEqualTypeOf<
      WritableWire<IntegrationSpawnSpec>
    >();
  });
  const spec = {
    integrationId: "@test/notes",
    namespace: "notes",
    sourceKind: "none" as const,
    manifest: { name: "notes", version: "1.0.0" },
    spawnEnv: {},
  };
  const parse = (input: unknown) =>
    readIntegrationSpecsFromEnv({ INTEGRATIONS_TO_SPAWN_JSON: JSON.stringify(input) });
  it("keeps a valid spec and distinguishes an empty list from malformed JSON", () => {
    expect(parse([spec])).toEqual([spec]);
    expect(parse([])).toEqual([]);
    expect(readIntegrationSpecsFromEnv({})).toBeNull();
    expect(() => readIntegrationSpecsFromEnv({ INTEGRATIONS_TO_SPAWN_JSON: "{" })).toThrow(
      "invalid JSON",
    );
    expect(() => parse({})).toThrow("expected an array");
  });
  it("validates a connect-run declaration with the same contract, naming only its public field", () => {
    const value = {
      ...spec,
      sourceKind: "local" as const,
      manifest: { ...spec.manifest, server: { type: "node" } },
    };
    expect(readConnectSpec(JSON.stringify(value))).toEqual(value);
    for (const [raw, diagnostic] of [
      ["{private-input", "CONNECT_LOGIN_JSON: invalid JSON"],
      [
        JSON.stringify({ ...value, sourceKind: "private-input" }),
        "CONNECT_LOGIN_JSON: invalid sourceKind",
      ],
      [
        JSON.stringify({ ...value, spawnEnv: { "private-name": 7 } }),
        "CONNECT_LOGIN_JSON: invalid spawnEnv",
      ],
    ]) {
      try {
        readConnectSpec(raw!);
        throw new Error("expected invalid declaration");
      } catch (error) {
        expect(error).toMatchObject({ issues: [diagnostic] });
      }
    }
  });

  it("fails a mixed list even for a malformed nested field and reports no input values", () => {
    try {
      parse([spec, { ...spec, connection: { id: 1, label: "private label", accountId: null } }]);
      throw new Error("expected invalid integration");
    } catch (error) {
      expect(error).toMatchObject({
        declaredConnections: 2,
        issues: ["INTEGRATIONS_TO_SPAWN_JSON[1]: invalid connection"],
      });
    }
  });
});
