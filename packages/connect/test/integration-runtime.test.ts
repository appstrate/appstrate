// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the integration runtime resolver / command builder /
 * compatibility validator. Pure functions, no spawn — every assertion is
 * a string-shape check that the orchestrator can rely on without
 * standing up Docker or a subprocess.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  IntegrationRuntimeError,
  buildProxyEnvInjection,
  buildSpawnCommand,
  resolveIntegrationServer,
  validateIntegrationServer,
  validateRuntimeCompatibility,
} from "../src/integration-runtime.ts";

type Server = IntegrationManifest["server"];

const BUNDLE_ROOT = "/tmp/bundle-xyz";

describe("validateIntegrationServer", () => {
  it("rejects npx sugar at runtime (must be bundled to node)", () => {
    expect(() =>
      validateIntegrationServer({ type: "npx", entryPoint: "./server.js" } as Server),
    ).toThrow(/AUTHORING_SUGAR_UNBUNDLED|sugar/i);
  });

  it("rejects uvx sugar at runtime", () => {
    expect(() =>
      validateIntegrationServer({ type: "uvx", entryPoint: "./main.py" } as Server),
    ).toThrow(/sugar/i);
  });

  it("rejects http transport (handled elsewhere)", () => {
    expect(() =>
      validateIntegrationServer({ type: "http", url: "https://api.example/mcp" } as Server),
    ).toThrow(/HTTP_TRANSPORT_UNSUPPORTED_HERE|http/i);
  });

  it("requires entryPoint for node/bun/python/uv/binary", () => {
    for (const type of ["node", "bun", "python", "uv", "binary"] as const) {
      expect(() => validateIntegrationServer({ type } as Server)).toThrow(
        /ENTRYPOINT_REQUIRED|entryPoint/,
      );
    }
  });

  it("requires digest for docker", () => {
    expect(() =>
      validateIntegrationServer({
        type: "docker",
        package: { registryType: "oci", identifier: "ghcr.io/foo/bar", digest: "" },
      } as unknown as Server),
    ).toThrow(/digest/);
  });

  it("rejects non-sha256 docker digest", () => {
    expect(() =>
      validateIntegrationServer({
        type: "docker",
        package: {
          registryType: "oci",
          identifier: "ghcr.io/foo/bar",
          digest: "sha256:notlongenough",
        },
      } as unknown as Server),
    ).toThrow(/sha256/);
  });

  it("accepts valid docker manifest with digest", () => {
    expect(() =>
      validateIntegrationServer({
        type: "docker",
        package: {
          registryType: "oci",
          identifier: "ghcr.io/scope/server",
          digest: `sha256:${"a".repeat(64)}`,
        },
      } as Server),
    ).not.toThrow();
  });

  it("accepts valid node manifest", () => {
    expect(() =>
      validateIntegrationServer({ type: "node", entryPoint: "./dist/server.js" } as Server),
    ).not.toThrow();
  });

  it("throws IntegrationRuntimeError with structured code", () => {
    try {
      validateIntegrationServer({ type: "npx", entryPoint: "./x.js" } as Server);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationRuntimeError);
      expect((err as IntegrationRuntimeError).code).toBe("AUTHORING_SUGAR_UNBUNDLED");
    }
  });
});

describe("resolveIntegrationServer — local-file branch", () => {
  it("resolves node entryPoint to absolute path under the bundle root", () => {
    const target = resolveIntegrationServer(
      { type: "node", entryPoint: "./dist/server.js" } as Server,
      BUNDLE_ROOT,
    );
    expect(target.kind).toBe("local-file");
    if (target.kind !== "local-file") throw new Error("unreachable");
    expect(target.type).toBe("node");
    expect(target.absoluteEntryPoint).toBe(`${BUNDLE_ROOT}/./dist/server.js`);
    expect(target.entryPoint).toBe("./dist/server.js");
  });

  it("rejects absolute entryPoint", () => {
    expect(() =>
      resolveIntegrationServer({ type: "node", entryPoint: "/etc/passwd" } as Server, BUNDLE_ROOT),
    ).toThrow(/relative to the bundle root/i);
  });

  it("rejects entryPoint with path traversal", () => {
    expect(() =>
      resolveIntegrationServer(
        { type: "binary", entryPoint: "./../../escape" } as Server,
        BUNDLE_ROOT,
      ),
    ).toThrow(/traversal|\.\./i);
  });

  it("handles bundle root with trailing slash without doubling separators", () => {
    const target = resolveIntegrationServer(
      { type: "uv", entryPoint: "./main.py" } as Server,
      "/tmp/bundle/",
    );
    if (target.kind !== "local-file") throw new Error("unreachable");
    expect(target.absoluteEntryPoint).toBe("/tmp/bundle/./main.py");
  });
});

describe("resolveIntegrationServer — docker branch", () => {
  const DIGEST = `sha256:${"b".repeat(64)}`;

  it("packs identifier + digest into imageRef", () => {
    const target = resolveIntegrationServer(
      {
        type: "docker",
        package: { registryType: "oci", identifier: "ghcr.io/x/y", digest: DIGEST },
      } as Server,
      BUNDLE_ROOT,
    );
    expect(target.kind).toBe("docker");
    if (target.kind !== "docker") throw new Error("unreachable");
    expect(target.imageRef).toBe(`ghcr.io/x/y@${DIGEST}`);
    expect(target.identifier).toBe("ghcr.io/x/y");
    expect(target.digest).toBe(DIGEST);
    expect(target.registryBaseUrl).toBeUndefined();
  });

  it("passes through optional registryBaseUrl", () => {
    const target = resolveIntegrationServer(
      {
        type: "docker",
        package: {
          registryType: "oci",
          identifier: "x/y",
          digest: DIGEST,
          registryBaseUrl: "https://ghcr.io",
        },
      } as Server,
      BUNDLE_ROOT,
    );
    if (target.kind !== "docker") throw new Error("unreachable");
    expect(target.registryBaseUrl).toBe("https://ghcr.io");
  });
});

describe("buildSpawnCommand — local-file targets", () => {
  it("node → bun (D31 — shebang override)", () => {
    const plan = buildSpawnCommand({
      kind: "local-file",
      type: "node",
      absoluteEntryPoint: "/bundle/dist/server.js",
      entryPoint: "./dist/server.js",
    });
    expect(plan.command).toBe("bun");
    expect(plan.args).toEqual(["/bundle/dist/server.js"]);
  });

  it("bun → bun", () => {
    const plan = buildSpawnCommand({
      kind: "local-file",
      type: "bun",
      absoluteEntryPoint: "/bundle/server.ts",
      entryPoint: "./server.ts",
    });
    expect(plan.command).toBe("bun");
    expect(plan.args).toEqual(["/bundle/server.ts"]);
  });

  it("python → python", () => {
    const plan = buildSpawnCommand({
      kind: "local-file",
      type: "python",
      absoluteEntryPoint: "/bundle/main.py",
      entryPoint: "./main.py",
    });
    expect(plan.command).toBe("python");
    expect(plan.args).toEqual(["/bundle/main.py"]);
  });

  it("uv → uv run <entry>", () => {
    const plan = buildSpawnCommand({
      kind: "local-file",
      type: "uv",
      absoluteEntryPoint: "/bundle/main.py",
      entryPoint: "./main.py",
    });
    expect(plan.command).toBe("uv");
    expect(plan.args).toEqual(["run", "/bundle/main.py"]);
  });

  it("binary → direct exec", () => {
    const plan = buildSpawnCommand({
      kind: "local-file",
      type: "binary",
      absoluteEntryPoint: "/bundle/bin/server",
      entryPoint: "./bin/server",
    });
    expect(plan.command).toBe("/bundle/bin/server");
    expect(plan.args).toEqual([]);
  });

  it("layers extraEnv into the plan env", () => {
    const plan = buildSpawnCommand(
      {
        kind: "local-file",
        type: "node",
        absoluteEntryPoint: "/bundle/x.js",
        entryPoint: "./x.js",
      },
      { extraEnv: { NOTION_TOKEN: "tok", HTTPS_PROXY: "http://127.0.0.1:8443" } },
    );
    expect(plan.env).toEqual({
      NOTION_TOKEN: "tok",
      HTTPS_PROXY: "http://127.0.0.1:8443",
    });
  });

  it("appends extraArgs after the entrypoint", () => {
    const plan = buildSpawnCommand(
      {
        kind: "local-file",
        type: "uv",
        absoluteEntryPoint: "/bundle/m.py",
        entryPoint: "./m.py",
      },
      { extraArgs: ["--verbose"] },
    );
    expect(plan.args).toEqual(["run", "/bundle/m.py", "--verbose"]);
  });
});

describe("buildSpawnCommand — docker target", () => {
  const DIGEST = `sha256:${"c".repeat(64)}`;

  it("uses `docker run --rm -i <imageRef>` with empty env (env passed via --env)", () => {
    const plan = buildSpawnCommand({
      kind: "docker",
      identifier: "ghcr.io/x/y",
      digest: DIGEST,
      imageRef: `ghcr.io/x/y@${DIGEST}`,
    });
    expect(plan.command).toBe("docker");
    expect(plan.args).toEqual(["run", "--rm", "-i", `ghcr.io/x/y@${DIGEST}`]);
    expect(plan.env).toEqual({});
  });

  it("propagates extraEnv via explicit --env KEY=VALUE pairs", () => {
    const plan = buildSpawnCommand(
      {
        kind: "docker",
        identifier: "x/y",
        digest: DIGEST,
        imageRef: `x/y@${DIGEST}`,
      },
      {
        extraEnv: { HTTPS_PROXY: "http://127.0.0.1:8443", NODE_EXTRA_CA_CERTS: "/run/afps/ca.pem" },
      },
    );
    // Env key order is insertion-order on Object.entries.
    expect(plan.args).toEqual([
      "run",
      "--rm",
      "-i",
      "--env",
      "HTTPS_PROXY=http://127.0.0.1:8443",
      "--env",
      "NODE_EXTRA_CA_CERTS=/run/afps/ca.pem",
      `x/y@${DIGEST}`,
    ]);
  });
});

describe("validateRuntimeCompatibility", () => {
  it("is a no-op when manifest declares no compatibility", () => {
    expect(() =>
      validateRuntimeCompatibility({} as IntegrationManifest, { mcpVersion: "1.0.0" }),
    ).not.toThrow();
  });

  it("accepts a satisfying semver range", () => {
    expect(() =>
      validateRuntimeCompatibility({ compatibility: { mcp: ">=1.0.0" } } as IntegrationManifest, {
        mcpVersion: "1.5.0",
      }),
    ).not.toThrow();
  });

  it("rejects an unsatisfied range", () => {
    let caught: unknown;
    try {
      validateRuntimeCompatibility({ compatibility: { mcp: ">=2.0.0" } } as IntegrationManifest, {
        mcpVersion: "1.5.0",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntegrationRuntimeError);
    expect((caught as IntegrationRuntimeError).code).toBe("INCOMPATIBLE_MCP_VERSION");
  });

  it("rejects an invalid range", () => {
    expect(() =>
      validateRuntimeCompatibility(
        { compatibility: { mcp: "not a range" } } as IntegrationManifest,
        { mcpVersion: "1.0.0" },
      ),
    ).toThrow(/INVALID_RANGE|valid semver/i);
  });

  it("coerces dated MCP protocol versions (YYYY-MM-DD) into semver form", () => {
    // MCP protocol uses date strings; ranges using the YYYYMMDD.0.0 shape
    // pass once the runtime version is coerced into the same shape.
    expect(() =>
      validateRuntimeCompatibility(
        { compatibility: { mcp: ">=20251125.0.0" } } as IntegrationManifest,
        { mcpVersion: "2025-11-25" },
      ),
    ).not.toThrow();
    let caught: unknown;
    try {
      validateRuntimeCompatibility(
        { compatibility: { mcp: ">=20251125.0.0" } } as IntegrationManifest,
        { mcpVersion: "2025-06-18" },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as IntegrationRuntimeError).code).toBe("INCOMPATIBLE_MCP_VERSION");
  });

  it("checks afps and mcp independently", () => {
    let caught: unknown;
    try {
      validateRuntimeCompatibility(
        { compatibility: { afps: ">=2.0.0", mcp: ">=1.0.0" } } as IntegrationManifest,
        { mcpVersion: "1.5.0", afpsVersion: "1.0.0" },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as IntegrationRuntimeError).code).toBe("INCOMPATIBLE_AFPS_VERSION");
  });
});

describe("buildProxyEnvInjection", () => {
  it("emits the full 6-tuple + 4 CA env vars", () => {
    const env = buildProxyEnvInjection({
      proxyUrl: "http://127.0.0.1:8443",
      caCertPath: "/run/afps/ca.pem",
      noProxy: ["host.docker.internal", "127.0.0.1"],
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8443");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8443");
    expect(env.https_proxy).toBe("http://127.0.0.1:8443");
    expect(env.http_proxy).toBe("http://127.0.0.1:8443");
    expect(env.NO_PROXY).toBe("host.docker.internal,127.0.0.1");
    expect(env.no_proxy).toBe("host.docker.internal,127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/run/afps/ca.pem");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/run/afps/ca.pem");
    expect(env.SSL_CERT_FILE).toBe("/run/afps/ca.pem");
    expect(env.CURL_CA_BUNDLE).toBe("/run/afps/ca.pem");
  });

  it("omits CA env vars when caCertPath is empty (caTrustEnv NONE binary)", () => {
    const env = buildProxyEnvInjection({
      proxyUrl: "http://127.0.0.1:8443",
      caCertPath: "",
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8443");
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
  });

  it("omits NO_PROXY when noProxy is empty/undefined", () => {
    const env = buildProxyEnvInjection({
      proxyUrl: "http://127.0.0.1:8443",
      caCertPath: "/x/ca.pem",
    });
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });
});
