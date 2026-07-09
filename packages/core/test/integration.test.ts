// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration manifest schema + install-time helper tests.
 *
 * Covers: source kinds (local/remote/api); oauth2 discovery + manual; api_key
 * / basic / custom + credentials; delivery http/env/files; connect.login
 * outputs + §7.7 gating; tools_policy metadata; the Appstrate cross-field
 * superRefine rules; validateManifest dispatch; and every exported helper.
 */

import { describe, it, expect } from "bun:test";
import {
  integrationManifestSchema,
  type IntegrationManifest,
  API_CALL_TOOL_NAME,
  getConnectToolNames,
  getDeclaredToolNames,
  getApiCallConfigs,
  getAvailableScopes,
  connectableAuthKeysForAgent,
  requiredScopesForAgent,
  scopesContributedByTools,
  expandScopesGranted,
  missingScopesForConnection,
  validateAgentIntegrationScopes,
  RESERVED_INTEGRATION_UPLOAD_PROTOCOLS,
  readDefaultTools,
  resolveEffectiveToolSelection,
} from "../src/integration.ts";
import { validateManifest, metaSchema } from "../src/validation.ts";

// ─────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────

/** A minimal valid AFPS integration with a single oauth2 auth + http delivery. */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@official/gmail",
    version: "1.0.0",
    type: "integration",
    schema_version: "0.1",
    display_name: "Gmail",
    source: { kind: "remote", remote: { url: "https://gmail/mcp", transport: "streamable-http" } },
    auths: {
      oauth: {
        type: "oauth2",
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        authorized_uris: ["https://gmail.googleapis.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
    ...overrides,
  };
}

function parse(raw: Record<string, unknown>): IntegrationManifest {
  return integrationManifestSchema.parse(raw);
}

function errorPaths(raw: Record<string, unknown>): string[] {
  const r = integrationManifestSchema.safeParse(raw);
  if (r.success) return [];
  return r.error.issues.map((i) => i.path.join("."));
}

// ─────────────────────────────────────────────
// Happy paths — source kinds
// ─────────────────────────────────────────────

describe("integrationManifestSchema — source kinds", () => {
  it("accepts a remote source", () => {
    const r = integrationManifestSchema.safeParse(baseManifest());
    expect(r.success).toBe(true);
  });

  it("accepts a local source referencing an mcp-server", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        source: { kind: "local", server: { name: "@official/gmail-server", version: "^1.2.0" } },
      }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a local source with vendored:true", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        source: {
          kind: "local",
          server: { name: "@official/gmail-server", version: "^1.0.0", vendored: true },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a none source (no MCP backing)", () => {
    const r = integrationManifestSchema.safeParse(baseManifest({ source: { kind: "none" } }));
    expect(r.success).toBe(true);
  });

  it("rejects the removed api source kind", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({ source: { kind: "api", api: {} } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects an unknown source kind", () => {
    const r = integrationManifestSchema.safeParse(baseManifest({ source: { kind: "ftp" } }));
    expect(r.success).toBe(false);
  });

  it("rejects a missing source", () => {
    const m = baseManifest();
    delete m.source;
    expect(errorPaths(m)).toContain("source");
  });
});

// ─────────────────────────────────────────────
// OAuth2 — discovery + manual
// ─────────────────────────────────────────────

describe("integrationManifestSchema — oauth2 discovery + manual", () => {
  it("accepts oauth2 with issuer only (discovery-first)", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    delete auths.oauth!.authorization_endpoint;
    delete auths.oauth!.token_endpoint;
    auths.oauth!.issuer = "https://accounts.google.com";
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("accepts oauth2 with manual endpoints and no issuer", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    delete auths.oauth!.issuer;
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects oauth2 with neither issuer nor endpoints on a non-remote source", () => {
    // §7.3 issuer-or-endpoints rule applies to non-remote sources. Use a local
    // source so the rule is in force (a remote source waives it — see below).
    const m = baseManifest({
      source: { kind: "local", server: { name: "@official/gmail-server", version: "^1.0.0" } },
    });
    const auths = m.auths as Record<string, Record<string, unknown>>;
    delete auths.oauth!.issuer;
    delete auths.oauth!.authorization_endpoint;
    delete auths.oauth!.token_endpoint;
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("accepts oauth2 with neither issuer nor endpoints on a remote source (§7.3 waiver, 0.6.0)", () => {
    // A remote MCP server discovers its authorization server at connect time
    // from `source.remote.url` (RFC 9728 → RFC 8414), so its oauth2 auth MAY
    // omit both issuer and explicit endpoints. baseManifest() is a remote source.
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    delete auths.oauth!.issuer;
    delete auths.oauth!.authorization_endpoint;
    delete auths.oauth!.token_endpoint;
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("accepts RFC 8414 fields: resource, code_challenge_methods_supported, authorization_params", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.resource = "https://gmail.googleapis.com";
    auths.oauth!.code_challenge_methods_supported = ["S256"];
    auths.oauth!.authorization_params = { access_type: "offline" };
    auths.oauth!.token_endpoint_auth_method = "client_secret_post";
    auths.oauth!.identity_claims = { account_id: "sub", email: "email" };
    auths.oauth!.required_identity_claims = ["sub"];
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Auth types — api_key / basic / custom + credentials
// ─────────────────────────────────────────────

const credSchema = {
  schema: { type: "object", properties: { api_key: { type: "string" } }, required: ["api_key"] },
};

describe("integrationManifestSchema — api_key/basic/custom credentials", () => {
  it("accepts api_key with credentials.schema + env delivery", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        source: { kind: "none" },
        auths: {
          key: {
            type: "api_key",
            credentials: credSchema,
            authorized_uris: ["https://api.example.com/**"],
            delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
          },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects api_key without credentials.schema", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        auths: {
          key: {
            type: "api_key",
            authorized_uris: ["https://api.example.com/**"],
            delivery: { env: { API_KEY: { value: "{$credential.api_key}" } } },
          },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts basic auth with credentials + files delivery (octal mode)", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        auths: {
          basic: {
            type: "basic",
            credentials: {
              schema: { type: "object", properties: { user: { type: "string" } } },
            },
            authorized_uris: ["https://api.example.com/**"],
            delivery: {
              files: { "/run/creds/token": { value: "{$credential.user}", mode: "0400" } },
            },
          },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects a file mode that is not octal", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        auths: {
          basic: {
            type: "basic",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api.example.com/**"],
            delivery: { files: { "/run/x": { value: "{$credential.user}", mode: "999" } } },
          },
        },
      }),
    );
    expect(r.success).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Delivery — exclusivity + at-least-one
// ─────────────────────────────────────────────

describe("integrationManifestSchema — delivery rules", () => {
  it("rejects a delivery with no channel", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.delivery = {};
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("rejects http mixed with env (mutually exclusive)", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.delivery = {
      http: { in: "header", name: "Authorization", value: "{$credential.access_token}" },
      env: { TOKEN: { value: "{$credential.access_token}" } },
    };
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("install-time error path cites §7.6 on the auths.{key}.delivery field (R8b)", () => {
    // AFPS §7.6 mutex: an auth method MUST NOT mix `http` (proxy
    // injection, server never holds the secret) with `env`/`files` (server
    // holds the secret). The error path MUST surface on the delivery field
    // so the editor lands the user on the right spot.
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.delivery = {
      http: { in: "header", name: "Authorization", value: "{$credential.access_token}" },
      env: { TOKEN: { value: "{$credential.access_token}" } },
    };
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const issues = r.error.issues;
      const onDelivery = issues.find((i) => i.path.join(".") === "auths.oauth.delivery");
      expect(onDelivery).toBeDefined();
      expect(onDelivery!.message).toMatch(/mutually exclusive|env\/files/);
    }
  });

  it("install-time mutex also rejects http mixed with files (R8b)", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.delivery = {
      http: { in: "header", name: "Authorization", value: "{$credential.access_token}" },
      files: { "/run/creds/token": { value: "{$credential.access_token}" } },
    };
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("accepts http with base64 encoding (HTTP Basic vendor pattern)", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        auths: {
          basic: {
            type: "basic",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api.example.com/**"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Basic ",
                value: "{$credential.email}/token:{$credential.api_key}",
                encoding: "base64",
              },
            },
          },
        },
      }),
    );
    expect(r.success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// URI restrictions (Appstrate cross-field rule)
// ─────────────────────────────────────────────

describe("integrationManifestSchema — authorized_uris", () => {
  it("rejects empty authorized_uris unless allow_all_uris", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.authorized_uris = [];
    expect(errorPaths(m)).toContain("auths.oauth.authorized_uris");
  });

  it("accepts empty authorized_uris when allow_all_uris is true", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.authorized_uris = [];
    auths.oauth!.allow_all_uris = true;
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("accepts a missing authorized_uris when allow_all_uris is true", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    delete auths.oauth!.authorized_uris;
    auths.oauth!.allow_all_uris = true;
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// credentials.schema $ref guard (§7.5 / §8.7 SSRF)
// ─────────────────────────────────────────────

describe("integrationManifestSchema — credentials.schema $ref SSRF guard", () => {
  it("rejects an external https $ref nested in credentials.schema (§7.5 / §8.7)", () => {
    // Note: AFPS requires credentials.schema to be a JSON Schema 2020-12
    // object schema (`type: "object" + properties`), so the $ref must live
    // inside a property (not at the root) to reach the SSRF guard at all.
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        foo: {
          type: "api_key",
          credentials: {
            schema: {
              type: "object",
              properties: {
                token: { $ref: "https://evil.example.com/schema.json" },
              },
            },
          },
          authorized_uris: ["https://api.example.com/**"],
          delivery: { env: { API_KEY: { value: "{$credential.token}" } } },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const onRef = r.error.issues.find((i) => i.message.includes("Non-fragment $ref"));
      expect(onRef).toBeDefined();
      expect(onRef!.path.join(".")).toBe("auths.foo.credentials.schema.properties.token.$ref");
    }
  });

  it("rejects a nested external $ref inside credentials.schema", () => {
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        foo: {
          type: "api_key",
          credentials: {
            schema: {
              type: "object",
              properties: {
                token: { $ref: "http://attacker/token.json" },
              },
            },
          },
          authorized_uris: ["https://api.example.com/**"],
          delivery: { env: { API_KEY: { value: "{$credential.token}" } } },
        },
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("accepts a local fragment $ref (#/$defs/Foo)", () => {
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        foo: {
          type: "api_key",
          credentials: {
            schema: {
              type: "object",
              properties: { token: { $ref: "#/$defs/Token" } },
              $defs: { Token: { type: "string" } },
            },
          },
          authorized_uris: ["https://api.example.com/**"],
          delivery: { env: { API_KEY: { value: "{$credential.token}" } } },
        },
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// delivery.http.in install gate (§7.6)
// ─────────────────────────────────────────────

describe("integrationManifestSchema — delivery.http.in install gate", () => {
  it("rejects delivery.http.in = 'query' (runtime only supports 'header')", () => {
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        key: {
          type: "api_key",
          credentials: { schema: { type: "object", properties: {} } },
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: {
              in: "query",
              name: "api_key",
              value: "{$credential.api_key}",
            },
          },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const onHttpIn = r.error.issues.find(
        (i) => i.path.join(".") === "auths.key.delivery.http.in",
      );
      expect(onHttpIn).toBeDefined();
      expect(onHttpIn!.message).toMatch(/only "header" is implemented/);
    }
  });

  it("rejects delivery.http.in = 'cookie'", () => {
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        key: {
          type: "api_key",
          credentials: { schema: { type: "object", properties: {} } },
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: { in: "cookie", name: "sid", value: "{$credential.api_key}" },
          },
        },
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("accepts delivery.http.in = 'header'", () => {
    // Sanity — the existing baseManifest declares delivery.http.in: "header"
    // implicitly via the oauth2 default; assert explicit header still parses.
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        key: {
          type: "api_key",
          credentials: { schema: { type: "object", properties: {} } },
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: {
              in: "header",
              name: "X-Api-Key",
              value: "{$credential.api_key}",
            },
          },
        },
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// mtls + delivery.http install gate (§7.6)
// ─────────────────────────────────────────────

describe("integrationManifestSchema — mtls + delivery.http install gate", () => {
  it("rejects mtls auth combined with delivery.http", () => {
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        client_cert: {
          type: "mtls",
          credentials: {
            schema: {
              type: "object",
              properties: {
                cert: { type: "string" },
                key: { type: "string" },
              },
              required: ["cert", "key"],
            },
          },
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: {
              in: "header",
              name: "X-Client-Cert",
              value: "{$credential.cert}",
            },
          },
        },
      },
    });
    const r = integrationManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    if (!r.success) {
      const onHttp = r.error.issues.find(
        (i) => i.path.join(".") === "auths.client_cert.delivery.http",
      );
      expect(onHttp).toBeDefined();
      expect(onHttp!.message).toMatch(/mtls \+ delivery\.http/);
    }
  });

  it("accepts mtls auth with delivery.files", () => {
    const m = baseManifest({
      source: { kind: "none" },
      auths: {
        client_cert: {
          type: "mtls",
          credentials: {
            schema: {
              type: "object",
              properties: {
                cert: { type: "string" },
                key: { type: "string" },
              },
              required: ["cert", "key"],
            },
          },
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            files: {
              "/etc/cert.pem": { value: "{$credential.cert}" },
              "/etc/key.pem": { value: "{$credential.key}" },
            },
          },
        },
      },
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// connect.login — outputs + §7.7 gating
// ─────────────────────────────────────────────

function customWithConnect(connect: Record<string, unknown>, delivery?: Record<string, unknown>) {
  return baseManifest({
    source: { kind: "none" },
    auths: {
      session: {
        type: "custom",
        credentials: { schema: { type: "object", properties: { email: { type: "string" } } } },
        authorized_uris: ["https://api.example.com/**"],
        connect,
        delivery: delivery ?? { env: { TOKEN: { value: "{$credential.token}" } } },
      },
    },
  });
}

describe("integrationManifestSchema — connect.login", () => {
  it("accepts a custom auth with a declarative login + outputs", () => {
    const r = integrationManifestSchema.safeParse(
      customWithConnect({
        login: {
          request: { method: "POST", url: "https://api.example.com/login" },
          success_criteria: [{ condition: "$statusCode == 200" }],
          outputs: { token: "$response.body#/access_token" },
        },
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects connect on a non-custom auth", () => {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.connect = {
      login: { request: { method: "POST", url: "https://x" }, outputs: { t: "$response.body#/t" } },
    };
    expect(integrationManifestSchema.safeParse(m).success).toBe(false);
  });

  it("rejects connect declaring both login and tool", () => {
    const r = integrationManifestSchema.safeParse(
      customWithConnect({
        login: {
          request: { method: "POST", url: "https://x" },
          outputs: { t: "$response.body#/t" },
        },
        tool: {},
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects a login with no outputs", () => {
    expect(
      errorPaths(
        customWithConnect({
          login: { request: { method: "POST", url: "https://api.example.com/login" } },
        }),
      ),
    ).toContain("auths.session.connect.login.outputs");
  });

  it("rejects expires_in_output that is not a declared output", () => {
    expect(
      errorPaths(
        customWithConnect({
          login: {
            request: { method: "POST", url: "https://x" },
            outputs: { token: "$response.body#/token" },
            expires_in_output: "exp",
          },
        }),
      ),
    ).toContain("auths.session.connect.login.expires_in_output");
  });

  it("rejects identity_outputs that are not declared outputs", () => {
    expect(
      errorPaths(
        customWithConnect({
          login: {
            request: { method: "POST", url: "https://x" },
            outputs: { token: "$response.body#/token" },
            identity_outputs: ["sub"],
          },
        }),
      ),
    ).toContain("auths.session.connect.login.identity_outputs");
  });

  it("§7.7 gating: rejects delivery referencing a non-output credential field", () => {
    expect(
      errorPaths(
        customWithConnect(
          {
            login: {
              request: { method: "POST", url: "https://x" },
              outputs: { token: "$response.body#/token" },
            },
          },
          { env: { TOKEN: { value: "{$credential.secret_login_password}" } } },
        ),
      ),
    ).toContain("auths.session.delivery");
  });

  it("§7.7 gating: accepts delivery referencing a declared output", () => {
    const r = integrationManifestSchema.safeParse(
      customWithConnect(
        {
          login: {
            request: { method: "POST", url: "https://x" },
            outputs: { token: "$response.body#/token" },
          },
        },
        { env: { TOKEN: { value: "{$credential.token}" } } },
      ),
    );
    expect(r.success).toBe(true);
  });

  it("accepts an orchestrated connect.tool", () => {
    const r = integrationManifestSchema.safeParse(
      customWithConnect({ tool: {} }, { env: { TOKEN: { value: "{$credential.token}" } } }),
    );
    expect(r.success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// scope_catalog cross-field rules
// ─────────────────────────────────────────────

describe("integrationManifestSchema — scope_catalog", () => {
  function withCatalog(extra: Record<string, unknown>): Record<string, unknown> {
    const m = baseManifest();
    const auths = m.auths as Record<string, Record<string, unknown>>;
    Object.assign(auths.oauth!, extra);
    return m;
  }

  it("accepts a scope_catalog and default_scopes subset", () => {
    const m = withCatalog({
      scope_catalog: [
        { value: "read", label: "Read" },
        { value: "write", label: "Write" },
      ],
      default_scopes: ["read"],
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects default_scopes outside the catalog", () => {
    const m = withCatalog({
      scope_catalog: [{ value: "read", label: "Read" }],
      default_scopes: ["write"],
    });
    expect(errorPaths(m)).toContain("auths.oauth.default_scopes");
  });

  it("accepts implies referencing another catalog value", () => {
    const m = withCatalog({
      scope_catalog: [
        { value: "admin", label: "Admin", implies: ["read"] },
        { value: "read", label: "Read" },
      ],
    });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects implies referencing a value not in the catalog", () => {
    const m = withCatalog({
      scope_catalog: [{ value: "admin", label: "Admin", implies: ["read"] }],
    });
    expect(errorPaths(m)).toContain("auths.oauth.scope_catalog");
  });

  it("rejects self-imply", () => {
    const m = withCatalog({
      scope_catalog: [{ value: "read", label: "Read", implies: ["read"] }],
    });
    expect(errorPaths(m)).toContain("auths.oauth.scope_catalog");
  });

  it("skips catalog validation when scope_catalog is omitted", () => {
    const m = withCatalog({ default_scopes: ["anything"] });
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// tools_policy.{name} metadata cross-field
// ─────────────────────────────────────────────

function multiAuthManifest(toolsPolicy: Record<string, unknown>): Record<string, unknown> {
  return baseManifest({
    source: { kind: "remote", remote: { url: "https://x/mcp", transport: "sse" } },
    auths: {
      oauth: {
        type: "oauth2",
        issuer: "https://idp",
        authorized_uris: ["https://api/**"],
        delivery: {
          http: { in: "header", name: "Authorization", value: "{$credential.access_token}" },
        },
        scope_catalog: [
          { value: "repo", label: "Repo" },
          { value: "read:org", label: "Read org" },
        ],
      },
      pat: {
        type: "api_key",
        credentials: { schema: { type: "object", properties: { token: { type: "string" } } } },
        authorized_uris: ["https://api/**"],
        delivery: { env: { TOKEN: { value: "{$credential.token}" } } },
      },
    },
    tools_policy: toolsPolicy,
  });
}

describe("integrationManifestSchema — tools_policy metadata", () => {
  it("accepts a tool with per-auth required_scopes (single auth)", () => {
    const m = baseManifest({
      tools_policy: {
        list_messages: {
          required_scopes: { oauth: ["read"] },
        },
      },
    });
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.scope_catalog = [{ value: "read", label: "Read" }];
    expect(integrationManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects required_scopes not in the targeted auth catalog", () => {
    expect(
      errorPaths(
        multiAuthManifest({
          list_issues: { required_scopes: { oauth: ["bogus"] } },
        }),
      ),
    ).toContain("tools_policy.list_issues.required_scopes.oauth");
  });

  it("rejects a required_scopes key that matches no auth", () => {
    expect(
      errorPaths(
        multiAuthManifest({
          list_issues: { required_scopes: { nope: ["repo"] } },
        }),
      ),
    ).toContain("tools_policy.list_issues.required_scopes.nope");
  });

  it("accepts a well-formed multi-auth tool", () => {
    const r = integrationManifestSchema.safeParse(
      multiAuthManifest({ list_issues: { required_scopes: { oauth: ["repo"] } } }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts scopes declared under multiple auths", () => {
    // pat has no scope_catalog, so only declare an empty set there; oauth scoped.
    const r = integrationManifestSchema.safeParse(
      multiAuthManifest({ list_issues: { required_scopes: { oauth: ["repo"], pat: [] } } }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a tool without required_scopes (default behaviour)", () => {
    const r = integrationManifestSchema.safeParse(
      baseManifest({
        tools_policy: { list_messages: {} },
      }),
    );
    expect(r.success).toBe(true);
  });
});

// ─────────────────────────────────────────────
// validateManifest dispatch
// ─────────────────────────────────────────────

describe("validateManifest — integration dispatch", () => {
  it("routes a valid integration manifest through the integration schema", () => {
    const r = validateManifest(baseManifest());
    expect(r.valid).toBe(true);
  });

  it("surfaces integration-specific errors on failure", () => {
    const m = baseManifest();
    delete m.source;
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("source"))).toBe(true);
  });
});

// ─────────────────────────────────────────────
// upload protocol reserved-values re-export
// ─────────────────────────────────────────────

describe("RESERVED_INTEGRATION_UPLOAD_PROTOCOLS", () => {
  it("matches the AFPS reserved set", () => {
    expect([...RESERVED_INTEGRATION_UPLOAD_PROTOCOLS].sort()).toEqual([
      "google-resumable",
      "ms-resumable",
      "s3-multipart",
      "tus",
    ]);
  });
});

// ─────────────────────────────────────────────
// Helpers — getApiCallConfigs / getDeclaredToolNames / getAvailableScopes
// ─────────────────────────────────────────────

describe("getApiCallConfigs", () => {
  function apiCallManifest(metaAuths: Record<string, unknown>): IntegrationManifest {
    return parse(
      baseManifest({
        source: { kind: "none" },
        auths: {
          key: {
            type: "api_key",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api/**"],
            delivery: { env: { K: { value: "{$credential.k}" } } },
          },
          alt: {
            type: "api_key",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api/**"],
            delivery: { env: { K2: { value: "{$credential.k}" } } },
          },
        },
        _meta: { "dev.appstrate/api": { auths: metaAuths } },
      }),
    );
  }

  it("returns a single api_call config with upload protocols + its api_upload companion", () => {
    const m = apiCallManifest({ key: { upload_protocols: ["tus"] } });
    expect(getApiCallConfigs(m)).toEqual([
      {
        authKey: "key",
        toolName: "api_call",
        uploadProtocols: ["tus"],
        uploadToolName: "api_upload",
      },
    ]);
  });

  it("omits uploadToolName when the auth declares no upload_protocols", () => {
    const m = apiCallManifest({ key: {} });
    expect(getApiCallConfigs(m)[0]).not.toHaveProperty("uploadToolName");
  });

  it("drops malformed upload_protocols entries (non-string / empty) rather than trusting them", () => {
    // The install-time superRefine already rejects these, so bypass `parse` —
    // this is the defence-in-depth path for manifests already stored in the DB.
    const m = {
      ...baseManifest({ source: { kind: "none" } }),
      _meta: {
        "dev.appstrate/api": {
          auths: { oauth: { upload_protocols: ["tus", "", 42, "s3-multipart"] } },
        },
      },
    } as unknown as IntegrationManifest;
    expect(getApiCallConfigs(m)).toEqual([
      {
        authKey: "oauth",
        toolName: "api_call",
        uploadProtocols: ["tus", "s3-multipart"],
        uploadToolName: "api_upload",
      },
    ]);
  });

  it("omits uploadToolName when every declared upload_protocol is malformed", () => {
    const m = {
      ...baseManifest({ source: { kind: "none" } }),
      _meta: { "dev.appstrate/api": { auths: { oauth: { upload_protocols: ["", 7] } } } },
    } as unknown as IntegrationManifest;
    expect(getApiCallConfigs(m)).toEqual([
      { authKey: "oauth", toolName: "api_call", uploadProtocols: [] },
    ]);
  });

  it("names per-auth tools when several auths opt in", () => {
    const m = apiCallManifest({ key: {}, alt: {} });
    expect(getApiCallConfigs(m)).toEqual([
      { authKey: "key", toolName: "api_call__key", uploadProtocols: [] },
      { authKey: "alt", toolName: "api_call__alt", uploadProtocols: [] },
    ]);
  });

  it("names the api_upload companion per-auth when several auths opt in", () => {
    const m = apiCallManifest({
      key: { upload_protocols: ["google-resumable"] },
      alt: { upload_protocols: ["tus"] },
    });
    expect(getApiCallConfigs(m).map((c) => c.uploadToolName)).toEqual([
      "api_upload__key",
      "api_upload__alt",
    ]);
  });

  it("returns [] when the integration declares no api_call extension", () => {
    expect(getApiCallConfigs(parse(baseManifest()))).toEqual([]);
  });

  it("works orthogonally to a local source (api_call alongside an MCP server)", () => {
    const m = parse(
      baseManifest({
        source: { kind: "local", server: { name: "@x/srv", version: "^1.0.0" } },
        _meta: { "dev.appstrate/api": { auths: { oauth: {} } } },
      }),
    );
    expect(getApiCallConfigs(m)).toEqual([
      { authKey: "oauth", toolName: "api_call", uploadProtocols: [] },
    ]);
  });
});

describe("getDeclaredToolNames / getAvailableScopes", () => {
  function withTools(): IntegrationManifest {
    const m = baseManifest({
      tools_policy: {
        list_messages: { required_scopes: { oauth: ["read"] } },
        send_message: { required_scopes: { oauth: ["write"] } },
      },
    });
    const auths = m.auths as Record<string, Record<string, unknown>>;
    auths.oauth!.scope_catalog = [
      { value: "read", label: "Read" },
      { value: "write", label: "Write" },
    ];
    return parse(m);
  }

  it("getDeclaredToolNames returns the tool record keys", () => {
    expect(getDeclaredToolNames(withTools()).sort()).toEqual(["list_messages", "send_message"]);
  });

  it("getDeclaredToolNames returns [] when no tools block", () => {
    expect(getDeclaredToolNames(parse(baseManifest()))).toEqual([]);
  });

  it("getAvailableScopes returns the union of catalog values", () => {
    expect([...getAvailableScopes(withTools())].sort()).toEqual(["read", "write"]);
  });

  it("getAvailableScopes returns [] with no catalog", () => {
    expect(getAvailableScopes(parse(baseManifest()))).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// getConnectToolNames — spec-natural + vendor _meta back-compat (R8b N-2)
// ─────────────────────────────────────────────

/** Build a custom-auth integration carrying a `connect.tool` block under the
 *  caller-specified shape. */
function connectToolManifest(connectBlock: Record<string, unknown>): IntegrationManifest {
  return parse(
    baseManifest({
      source: { kind: "none" },
      auths: {
        session: {
          type: "custom",
          credentials: {
            schema: { type: "object", properties: { token: { type: "string" } } },
          },
          authorized_uris: ["https://api.example.com/**"],
          connect: connectBlock,
          delivery: { env: { TOKEN: { value: "{$credential.token}" } } },
        },
      },
    }),
  );
}

describe("getConnectToolNames — AFPS spec-natural", () => {
  it("reads the spec-natural `connect.tool.name` location (R8b N-2)", () => {
    // AFPS §7.7: `connect.tool` is the canonical block for the
    // orchestrated-acquisition mode; the inner `name` is the tool reference.
    const m = connectToolManifest({ tool: { name: "perform_login" } });
    expect(getConnectToolNames(m)).toEqual(["perform_login"]);
  });

  it("returns [] when no auth declares connect.tool", () => {
    expect(getConnectToolNames(parse(baseManifest()))).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// scope expansion + missing scopes
// ─────────────────────────────────────────────

function scopedManifest(): IntegrationManifest {
  const m = baseManifest({
    tools_policy: {
      read_tool: { required_scopes: { oauth: ["read:org"] } },
      admin_tool: { required_scopes: { oauth: ["admin:org"] } },
    },
  });
  const auths = m.auths as Record<string, Record<string, unknown>>;
  auths.oauth!.scope_catalog = [
    { value: "admin:org", label: "Admin", implies: ["write:org"] },
    { value: "write:org", label: "Write", implies: ["read:org"] },
    { value: "read:org", label: "Read" },
  ];
  return parse(m);
}

describe("expandScopesGranted", () => {
  it("expands transitively (admin:org → write:org → read:org)", () => {
    expect(expandScopesGranted(["admin:org"], scopedManifest(), "oauth").sort()).toEqual(
      ["admin:org", "read:org", "write:org"].sort(),
    );
  });

  it("returns granted deduplicated when no catalog", () => {
    expect(expandScopesGranted(["a", "a", "b"], parse(baseManifest()), "oauth").sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns granted unchanged for an unknown auth key", () => {
    expect(expandScopesGranted(["x"], scopedManifest(), "nope")).toEqual(["x"]);
  });
});

describe("scopesContributedByTools / requiredScopesForAgent", () => {
  const m = scopedManifest();

  it("unions required_scopes across the selected tools", () => {
    expect(
      scopesContributedByTools({
        manifest: m,
        authKey: "oauth",
        agentTools: ["read_tool", "admin_tool"],
      }).sort(),
    ).toEqual(["admin:org", "read:org"].sort());
  });

  it("returns [] with no tools selected", () => {
    expect(scopesContributedByTools({ manifest: m, authKey: "oauth", agentTools: [] })).toEqual([]);
  });

  it("requiredScopesForAgent unions tool-inferred + explicit scopes", () => {
    expect(
      requiredScopesForAgent({
        manifest: m,
        authKey: "oauth",
        agentTools: ["read_tool"],
        agentScopes: ["extra"],
      }).sort(),
    ).toEqual(["extra", "read:org"].sort());
  });

  it('requiredScopesForAgent returns the auth\'s default_scopes when agentTools is "*"', () => {
    const withDefaults = parse(
      baseManifest({
        allow_undeclared_tools: true,
        auths: {
          oauth: {
            type: "oauth2",
            issuer: "https://accounts.google.com",
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            authorized_uris: ["https://gmail.googleapis.com/**"],
            default_scopes: ["read", "write"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Bearer ",
                value: "{$credential.access_token}",
              },
            },
          },
        },
      }),
    );
    expect(
      requiredScopesForAgent({
        manifest: withDefaults,
        authKey: "oauth",
        agentTools: "*",
        agentScopes: undefined,
      }).sort(),
    ).toEqual(["read", "write"]);
    // Still unions explicit agentScopes.
    expect(
      requiredScopesForAgent({
        manifest: withDefaults,
        authKey: "oauth",
        agentTools: "*",
        agentScopes: ["extra"],
      }).sort(),
    ).toEqual(["extra", "read", "write"]);
  });
});

describe("missingScopesForConnection", () => {
  const m = scopedManifest();

  it("reports scopes the grant lacks (after implies expansion)", () => {
    expect(
      missingScopesForConnection({
        manifest: m,
        authKey: "oauth",
        granted: ["write:org"],
        agentTools: ["read_tool", "admin_tool"],
        agentScopes: undefined,
      }),
    ).toEqual(["admin:org"]);
  });

  it("returns [] when the grant covers everything", () => {
    expect(
      missingScopesForConnection({
        manifest: m,
        authKey: "oauth",
        granted: ["admin:org"],
        agentTools: ["read_tool", "admin_tool"],
        agentScopes: undefined,
      }),
    ).toEqual([]);
  });

  it("returns [] for a non-oauth2 auth even with declared scopes", () => {
    const api = parse(
      baseManifest({
        source: { kind: "none" },
        auths: {
          key: {
            type: "api_key",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api/**"],
            delivery: { env: { K: { value: "{$credential.k}" } } },
          },
        },
      }),
    );
    expect(
      missingScopesForConnection({
        manifest: api,
        authKey: "key",
        granted: [],
        agentTools: undefined,
        agentScopes: ["whatever"],
      }),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// connectableAuthKeysForAgent
// ─────────────────────────────────────────────

describe("connectableAuthKeysForAgent", () => {
  it("returns [] when the agent picked nothing", () => {
    expect(connectableAuthKeysForAgent(multiAuthManifest_(), undefined, undefined)).toEqual([]);
    expect(connectableAuthKeysForAgent(multiAuthManifest_(), [], [])).toEqual([]);
  });

  it("offers EVERY declared auth as a candidate, not just the scope-anchored one", () => {
    // The scope-anchor pins list_issues to oauth, but a pat connection serves
    // it equally — the picker must offer both (this is the schedule-override bug).
    const m = parse(multiAuthManifest({ list_issues: { required_scopes: { oauth: ["repo"] } } }));
    expect(connectableAuthKeysForAgent(m, ["list_issues"], undefined).sort()).toEqual([
      "oauth",
      "pat",
    ]);
  });

  it("offers all declared auths on scope-only selection too", () => {
    const m = parse(multiAuthManifest({}));
    expect(connectableAuthKeysForAgent(m, undefined, ["repo"]).sort()).toEqual(["oauth", "pat"]);
  });

  it("single-auth integration returns the lone auth", () => {
    expect(connectableAuthKeysForAgent(scopedManifest(), ["read_tool"], undefined)).toEqual([
      "oauth",
    ]);
  });

  it('wildcard tools="*" returns every declared auth (picker offers all candidates)', () => {
    // The wildcard form is an "active selection" — the picker MUST offer every
    // declared auth as a connection candidate, mirroring the multi-tool case.
    expect(connectableAuthKeysForAgent(multiAuthManifest_(), "*", undefined).sort()).toEqual([
      "oauth",
      "pat",
    ]);
  });

  it("offers declared auths for an api_call integration with no tools/scopes", () => {
    // api_call-only integration (source.kind "none", api vendor extension):
    // the agent consumes it via api_call with an explicit auth_key pin, so it
    // has no tools/scopes yet still needs a connection. The picker MUST offer
    // it — this is the empty schedule-override box bug.
    const m = parse(
      baseManifest({
        source: { kind: "none" },
        auths: {
          primary: {
            type: "api_key",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api/**"],
            delivery: { env: { K: { value: "{$credential.k}" } } },
          },
        },
        _meta: { "dev.appstrate/api": { auths: { primary: {} } } },
      }),
    );
    expect(connectableAuthKeysForAgent(m, undefined, undefined)).toEqual(["primary"]);
  });
});

function multiAuthManifest_(): IntegrationManifest {
  return parse(multiAuthManifest({}));
}

// ─────────────────────────────────────────────
// validateAgentIntegrationScopes
// ─────────────────────────────────────────────

describe("validateAgentIntegrationScopes", () => {
  const m = scopedManifest();

  it("returns no errors for an empty selection", () => {
    expect(validateAgentIntegrationScopes({ id: "@official/gmail" }, m)).toEqual([]);
  });

  it("accepts a subset selection of declared tools and catalog scopes", () => {
    expect(
      validateAgentIntegrationScopes(
        { id: "@official/gmail", tools: ["read_tool"], scopes: ["read:org"] },
        m,
      ),
    ).toEqual([]);
  });

  it("flags an unknown tool", () => {
    const errs = validateAgentIntegrationScopes({ id: "@official/gmail", tools: ["nope"] }, m);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("unknown_tool");
  });

  it("flags a scope outside the catalog", () => {
    const errs = validateAgentIntegrationScopes({ id: "@official/gmail", scopes: ["bogus"] }, m);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("scope_not_in_catalog");
  });

  it("accepts the synthetic api_call tool on an api_call integration", () => {
    const api = parse(
      baseManifest({
        source: { kind: "none" },
        auths: {
          key: {
            type: "api_key",
            credentials: { schema: { type: "object", properties: {} } },
            authorized_uris: ["https://api/**"],
            delivery: { env: { K: { value: "{$credential.k}" } } },
          },
        },
        tools_policy: { real_tool: { required_scopes: {} } },
        _meta: { "dev.appstrate/api": { auths: { key: {} } } },
      }),
    );
    expect(
      validateAgentIntegrationScopes({ id: "@official/gmail", tools: [API_CALL_TOOL_NAME] }, api),
    ).toEqual([]);
  });

  it('accepts tools: "*" when the integration declares allow_undeclared_tools: true', () => {
    const wildcardOk = parse(
      baseManifest({
        allow_undeclared_tools: true,
        auths: {
          oauth: {
            type: "oauth2",
            issuer: "https://accounts.google.com",
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            authorized_uris: ["https://gmail.googleapis.com/**"],
            default_scopes: ["read"],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Bearer ",
                value: "{$credential.access_token}",
              },
            },
          },
        },
      }),
    );
    expect(
      validateAgentIntegrationScopes({ id: "@official/gmail", tools: "*" }, wildcardOk),
    ).toEqual([]);
  });

  it('rejects tools: "*" when the integration does NOT declare allow_undeclared_tools', () => {
    const errs = validateAgentIntegrationScopes({ id: "@official/gmail", tools: "*" }, m);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("wildcard_not_authorized");
    expect(errs[0]!.field).toBe("integrations_configuration.@official/gmail.tools");
  });
});

// ─────────────────────────────────────────────
// `_meta` namespace key validation
// ─────────────────────────────────────────────
//
// AFPS 0.1 Appendix B defines META_NAMESPACE_KEY as a strict regex (an OPTIONAL
// reverse-DNS namespace + `/` + identifier, or a bare identifier). As of AFPS
// 0.1 the upstream `@afps-spec/schema` `metaSchema` is STRICT: it enforces that
// pattern AND folds in a reserved-prefix negative-lookahead, hard-rejecting both
// malformed namespace keys and the §10 reserved `mcp/` / `modelcontextprotocol/`
// prefixes at parse time.
//
// Per §10.1, consumers MUST NOT reject WELL-FORMED but unknown `_meta` keys —
// but a MALFORMED key makes the package malformed, which §2 says consumers MUST
// reject. appstrate delegates entirely to the upstream schema (no local refine).
describe("_meta namespace key validation (delegated to upstream 0.1 schema)", () => {
  it("rejects _meta keys that do not match META_NAMESPACE_KEY regex (§2 malformed key)", () => {
    const r = metaSchema.safeParse({ "BAD KEY": {} });
    expect(r.success).toBe(false);
  });

  it("rejects _meta keys using the reserved `mcp/` prefix per AFPS §10", () => {
    const r = metaSchema.safeParse({ "mcp/reserved": {} });
    expect(r.success).toBe(false);
    // The rejection now comes from the upstream Zod regex (reserved-prefix
    // negative-lookahead), not a custom appstrate message — assert the
    // offending key is referenced rather than a specific message string.
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("mcp/reserved"))).toBe(true);
    }
  });

  it("rejects _meta keys using the reserved `modelcontextprotocol/` prefix per AFPS §10", () => {
    const r = metaSchema.safeParse({ "modelcontextprotocol/x": {} });
    expect(r.success).toBe(false);
  });

  it("rejects _meta keys whose namespace contains uppercase letters (§2 malformed key)", () => {
    // Appendix B requires lowercase namespace segments — a `/`-prefixed key whose
    // namespace has uppercase is malformed and is hard-rejected by the upstream
    // 0.1 schema (only WELL-FORMED unknown keys are tolerated per §10.1).
    const r = metaSchema.safeParse({ "dev.AFPS/x": {} });
    expect(r.success).toBe(false);
  });

  it("accepts the transitional `dev.appstrate.afps/` alias (spec editorial note §10)", () => {
    const r = metaSchema.safeParse({ "dev.appstrate.afps/x": {} });
    expect(r.success).toBe(true);
  });

  it("accepts a vendor reverse-DNS _meta key (`dev.appstrate/foo`)", () => {
    const r = metaSchema.safeParse({ "dev.appstrate/foo": {} });
    expect(r.success).toBe(true);
  });
});

describe("integrationManifestSchema — default_tools (AFPS §4.4)", () => {
  // An api-only integration (source.kind "none") exposing `api_call` on `key`.
  // For a "none" source the full tool catalog is knowable from this manifest
  // alone, so array membership is validated.
  function apiManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return baseManifest({
      source: { kind: "none" },
      auths: {
        key: {
          type: "api_key",
          credentials: { schema: { type: "object", properties: {} } },
          authorized_uris: ["https://api/**"],
          delivery: { env: { K: { value: "{$credential.k}" } } },
        },
      },
      _meta: { "dev.appstrate/api": { auths: { key: {} } } },
      ...overrides,
    });
  }

  it("accepts default_tools naming a real exposed tool (api_call) on an api-only source", () => {
    const r = integrationManifestSchema.safeParse(apiManifest({ default_tools: ["api_call"] }));
    expect(r.success).toBe(true);
  });

  it("rejects a default_tools entry that is not an exposed tool (source none → catalog known)", () => {
    expect(errorPaths(apiManifest({ default_tools: ["api_call", "nope"] }))).toContain(
      "default_tools",
    );
  });

  it("rejects a non-string / non-wildcard default_tools value", () => {
    expect(errorPaths(apiManifest({ default_tools: [42] }))).toContain("default_tools");
    expect(errorPaths(apiManifest({ default_tools: "all" }))).toContain("default_tools");
  });

  it('rejects default_tools "*" without allow_undeclared_tools', () => {
    expect(errorPaths(apiManifest({ default_tools: "*" }))).toContain("default_tools");
  });

  it('accepts default_tools "*" when allow_undeclared_tools is true', () => {
    // The api_key auth is wildcard-usable (non-oauth2), satisfying the base
    // `allow_undeclared_tools` rule.
    const r = integrationManifestSchema.safeParse(
      apiManifest({ default_tools: "*", allow_undeclared_tools: true }),
    );
    expect(r.success).toBe(true);
  });

  it("does not validate array membership for non-none sources (catalog lives in the mcp-server)", () => {
    // A remote source's authoritative tool list is the upstream MCP server's,
    // unknowable in a pure-manifest superRefine — so an arbitrary name is left
    // for runtime rather than falsely rejected.
    const r = integrationManifestSchema.safeParse(
      baseManifest({ default_tools: ["some_remote_tool"] }),
    );
    expect(r.success).toBe(true);
  });
});

describe("readDefaultTools", () => {
  const mk = (d: unknown) => ({ default_tools: d }) as unknown as IntegrationManifest;

  it("reads a string array", () => {
    expect(readDefaultTools(mk(["api_call"]))).toEqual(["api_call"]);
  });
  it("reads the wildcard literal", () => {
    expect(readDefaultTools(mk("*"))).toBe("*");
  });
  it("returns undefined when absent", () => {
    expect(readDefaultTools({} as IntegrationManifest)).toBeUndefined();
  });
  it("returns undefined for malformed values (defence in depth)", () => {
    expect(readDefaultTools(mk([1, 2]))).toBeUndefined();
    expect(readDefaultTools(mk("all"))).toBeUndefined();
    expect(readDefaultTools(mk(null))).toBeUndefined();
  });
});

describe("resolveEffectiveToolSelection", () => {
  const withDefault = (d: unknown) => ({ default_tools: d }) as unknown as IntegrationManifest;
  const noDefault = {} as IntegrationManifest;

  it("an explicit array selection wins over the default", () => {
    expect(resolveEffectiveToolSelection(["x"], withDefault(["api_call"]))).toEqual(["x"]);
  });
  it("an explicit empty array overrides the default (zero tools)", () => {
    expect(resolveEffectiveToolSelection([], withDefault(["api_call"]))).toEqual([]);
  });
  it("an explicit wildcard wins over the default", () => {
    expect(resolveEffectiveToolSelection("*", withDefault(["api_call"]))).toBe("*");
  });
  it("an undefined selection falls back to the declared default", () => {
    expect(resolveEffectiveToolSelection(undefined, withDefault(["api_call"]))).toEqual([
      "api_call",
    ]);
  });
  it("an undefined selection with no declared default stays undefined", () => {
    expect(resolveEffectiveToolSelection(undefined, noDefault)).toBeUndefined();
  });
});
