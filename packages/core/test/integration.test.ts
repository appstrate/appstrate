// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the AFPS integration manifest schema (Phase 1.0,
 * INTEGRATIONS_PROPOSAL §4.1.1). Exercises the runtime-discriminated
 * cases (entryPoint vs package vs url), D31/D32 enforcement, multi-auth
 * delivery, and dispatch through `validateManifest`.
 */

import { describe, expect, it } from "bun:test";
import {
  integrationManifestSchema,
  integrationServerTypeEnum,
  caTrustEnvEnum,
} from "../src/integration.ts";
import { validateManifest } from "../src/validation.ts";

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: "1.1",
    type: "integration",
    name: "@official/gmail",
    version: "1.0.0",
    displayName: "Gmail",
    server: {
      type: "node",
      entryPoint: "./server/index.js",
    },
    ...overrides,
  };
}

describe("integrationServerTypeEnum", () => {
  it("accepts every runtime + author sugar", () => {
    for (const t of ["node", "bun", "python", "uv", "binary", "docker", "http", "npx", "uvx"]) {
      expect(integrationServerTypeEnum.parse(t)).toBe(t as never);
    }
  });

  it("rejects unknown runtimes", () => {
    expect(() => integrationServerTypeEnum.parse("deno")).toThrow();
  });
});

describe("caTrustEnvEnum", () => {
  it("covers the documented runtime CA trust env vars", () => {
    for (const t of [
      "SSL_CERT_FILE",
      "NODE_EXTRA_CA_CERTS",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "NONE",
    ]) {
      expect(caTrustEnvEnum.parse(t)).toBe(t as never);
    }
  });

  it("rejects values outside the closed enum", () => {
    expect(() => caTrustEnvEnum.parse("CA_BUNDLE")).toThrow();
  });
});

describe("integrationManifestSchema — happy paths", () => {
  it("accepts the minimal node manifest", () => {
    const parsed = integrationManifestSchema.parse(baseManifest());
    expect(parsed.type).toBe("integration");
    expect(parsed.server.type).toBe("node");
    expect(parsed.server.entryPoint).toBe("./server/index.js");
  });

  it("accepts a docker manifest with digest", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        package: {
          registryType: "oci",
          identifier: "ghcr.io/vendor/mcp-server",
          digest: "sha256:" + "a".repeat(64),
        },
      },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.server.type).toBe("docker");
    expect(parsed.server.package?.digest).toMatch(/^sha256:/);
  });

  it("accepts a remote http manifest", () => {
    const m = baseManifest({
      server: { type: "http", url: "https://api.example.com/mcp/{tenantId}" },
      transport: { type: "streamable-http" },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a binary manifest when httpClient is declared", () => {
    const m = baseManifest({
      server: {
        type: "binary",
        entryPoint: "./bin/foo",
        httpClient: { caTrustEnv: "SSL_CERT_FILE" },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a binary manifest with caTrustEnv: NONE (opt-in egress unobservable)", () => {
    // The schema accepts NONE; the runtime install flow is responsible
    // for surfacing the warning + requiring explicit user opt-in.
    const m = baseManifest({
      server: {
        type: "binary",
        entryPoint: "./bin/foo",
        httpClient: { caTrustEnv: "NONE" },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts a manifest with one oauth2 auth + http delivery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          audience: "https://gmail.googleapis.com",
          scopes: ["gmail.send"],
          authorizedUris: ["https://gmail.googleapis.com/*"],
          delivery: {
            http: {
              headerName: "Authorization",
              headerPrefix: "Bearer ",
              valueFrom: "accessToken",
            },
          },
        },
      },
    });
    const parsed = integrationManifestSchema.parse(m);
    expect(parsed.auths?.primary?.type).toBe("oauth2");
    expect(parsed.auths?.primary?.delivery.http?.headerName).toBe("Authorization");
  });

  it("accepts multi-auth (github + linear)", () => {
    const m = baseManifest({
      auths: {
        github: {
          type: "oauth2",
          authorizationUrl: "https://github.com/login/oauth/authorize",
          tokenUrl: "https://github.com/login/oauth/access_token",
          authorizedUris: ["https://api.github.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
        linear: {
          type: "oauth2",
          authorizationUrl: "https://linear.app/oauth/authorize",
          tokenUrl: "https://api.linear.app/oauth/token",
          authorizedUris: ["https://api.linear.app/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts an api_key auth with credentials.schema + env delivery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/*"],
          credentials: {
            schema: {
              type: "object",
              properties: { api_key: { type: "string" } },
              required: ["api_key"],
            },
          },
          delivery: {
            env: {
              EXAMPLE_API_KEY: { from: "api_key", sensitive: true },
            },
          },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });
});

describe("integrationManifestSchema — server discrimination", () => {
  it("rejects entryPoint when type is docker", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        entryPoint: "./oops.js",
        package: {
          registryType: "oci",
          identifier: "x",
          digest: "sha256:" + "a".repeat(64),
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects docker without a digest", () => {
    const m = baseManifest({
      server: {
        type: "docker",
        package: { registryType: "oci", identifier: "x", digest: "latest" },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects http without a url", () => {
    const m = baseManifest({ server: { type: "http" } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects node without an entryPoint", () => {
    const m = baseManifest({ server: { type: "node" } });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects binary without httpClient.caTrustEnv (D32)", () => {
    const m = baseManifest({
      server: { type: "binary", entryPoint: "./bin/foo" },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join("|");
      expect(messages).toMatch(/D32|caTrustEnv|httpClient/);
    }
  });
});

describe("integrationManifestSchema — auth discrimination", () => {
  it("rejects oauth2 with neither explicit endpoints nor discovery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("accepts oauth2 with discovery alone (RFC 9728)", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          discovery: {
            protectedResourceMetadataUrl:
              "https://api.example.com/.well-known/oauth-protected-resource",
          },
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects api_key without credentials.schema", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { env: { TOKEN: { from: "api_key" } } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects an auth with empty delivery", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://x/a",
          tokenUrl: "https://x/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: {},
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects an auth with empty authorizedUris", () => {
    const m = baseManifest({
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://x/a",
          tokenUrl: "https://x/t",
          authorizedUris: [],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects auth keys that don't match the required pattern", () => {
    const m = baseManifest({
      auths: {
        "Primary-Key": {
          type: "oauth2",
          authorizationUrl: "https://x/a",
          tokenUrl: "https://x/t",
          authorizedUris: ["https://api.example.com/*"],
          delivery: { http: { valueFrom: "accessToken" } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });
});

describe("integrationManifestSchema — serverAuth", () => {
  it("rejects serverAuth on stdio transport", () => {
    const m = baseManifest({
      serverAuth: {
        type: "oauth2-mcp",
        resource: "https://mcp.vendor.com",
        discovery: "auto",
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("accepts serverAuth on streamable-http transport", () => {
    const m = baseManifest({
      server: { type: "http", url: "https://mcp.vendor.com" },
      transport: { type: "streamable-http" },
      serverAuth: {
        type: "oauth2-mcp",
        resource: "https://mcp.vendor.com",
        discovery: "auto",
      },
    });
    expect(() => integrationManifestSchema.parse(m)).not.toThrow();
  });
});

describe("integrationManifestSchema — naming + required fields", () => {
  it("rejects a non-scoped name", () => {
    const m = baseManifest({ name: "just-a-name" });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects an invalid manifestVersion", () => {
    const m = baseManifest({ manifestVersion: "2.0" });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it("rejects a manifest missing displayName", () => {
    const { displayName: _drop, ...rest } = baseManifest();
    const r = integrationManifestSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects a manifest with wrong type", () => {
    const m = baseManifest({ type: "agent" });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });
});

describe("validateManifest — dispatch to integration schema", () => {
  it("routes a valid integration manifest through the integration schema", () => {
    const res = validateManifest(baseManifest());
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.manifest.type).toBe("integration");
    }
  });

  it("surfaces integration-specific errors when validation fails", () => {
    const res = validateManifest(baseManifest({ server: { type: "node" } }));
    expect(res.valid).toBe(false);
    if (!res.valid) {
      const joined = res.errors.join("|");
      expect(joined).toMatch(/entryPoint/);
    }
  });
});

describe("integrationManifestSchema — author/repository union", () => {
  it("accepts author as plain string or object", () => {
    expect(() => integrationManifestSchema.parse(baseManifest({ author: "Pierre" }))).not.toThrow();
    expect(() =>
      integrationManifestSchema.parse(
        baseManifest({ author: { name: "Pierre", email: "p@x.io" } }),
      ),
    ).not.toThrow();
  });

  it("accepts repository as plain string or {type, url}", () => {
    expect(() =>
      integrationManifestSchema.parse(baseManifest({ repository: "https://x.io/r" })),
    ).not.toThrow();
    expect(() =>
      integrationManifestSchema.parse(
        baseManifest({ repository: { type: "git", url: "https://x.io/r" } }),
      ),
    ).not.toThrow();
  });
});
