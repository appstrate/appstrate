// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  getAllowUndeclaredTools,
  getAuths,
  getSource,
  getToolsPolicy,
  emptyAuth,
  setAllowUndeclaredTools,
  setAuths,
  setSource,
  setToolsPolicy,
} from "../utils";

describe("integration-editor source", () => {
  it("round-trips a remote source", () => {
    const m = setSource(
      {},
      {
        kind: "remote",
        remoteUrl: "https://x.test/mcp/v1",
        remoteTransport: "streamable-http",
        serverName: "",
        serverVersion: "",
      },
    );
    expect((m.source as any).kind).toBe("remote");
    expect((m.source as any).remote.url).toBe("https://x.test/mcp/v1");
    const back = getSource(m);
    expect(back.kind).toBe("remote");
    expect(back.remoteUrl).toBe("https://x.test/mcp/v1");
  });

  it("round-trips a local source", () => {
    const m = setSource(
      {},
      {
        kind: "local",
        remoteUrl: "",
        remoteTransport: "streamable-http",
        serverName: "@scope/srv",
        serverVersion: "^1.0.0",
      },
    );
    expect((m.source as any).kind).toBe("local");
    expect((m.source as any).server.name).toBe("@scope/srv");
    expect(getSource(m).serverVersion).toBe("^1.0.0");
  });
});

describe("integration-editor auths", () => {
  it("writes an api_key auth with delivery + credentials.schema", () => {
    const m = setAuths({}, [emptyAuth("primary")]);
    const auth = (m.auths as any).primary;
    expect(auth.type).toBe("api_key");
    expect(auth.authorized_uris).toEqual([]);
    expect(auth.delivery.http).toMatchObject({
      in: "header",
      name: "Authorization",
      prefix: "Bearer ",
      value: "{$credential.api_key}",
    });
    expect(auth.credentials.schema.required).toEqual(["api_key"]);
    expect(auth.credentials.schema.properties.api_key).toEqual({ type: "string" });
  });

  it("emits allow_all_uris instead of authorized_uris when set", () => {
    const a = { ...emptyAuth("primary"), allowAllUris: true };
    const m = setAuths({}, [a]);
    const auth = (m.auths as any).primary;
    expect(auth.allow_all_uris).toBe(true);
    expect(auth.authorized_uris).toBeUndefined();
  });

  it("round-trips an oauth2 auth with scope_catalog", () => {
    const a = {
      ...emptyAuth("primary"),
      type: "oauth2" as const,
      authorizationEndpoint: "https://x.test/authorize",
      tokenEndpoint: "https://x.test/token",
      defaultScopes: ["read"],
      scopeCatalog: [{ value: "read", label: "Read" }],
      credentialFields: [],
    };
    const m = setAuths({}, [a]);
    const auth = (m.auths as any).primary;
    expect(auth.authorization_endpoint).toBe("https://x.test/authorize");
    expect(auth.scope_catalog).toEqual([{ value: "read", label: "Read" }]);
    expect(auth.credentials).toBeUndefined();

    const back = getAuths(m)[0]!;
    expect(back.type).toBe("oauth2");
    expect(back.defaultScopes).toEqual(["read"]);
    expect(back.scopeCatalog[0]!.value).toBe("read");
  });

  it("drops auths with an empty key", () => {
    const m = setAuths({}, [{ ...emptyAuth(""), key: "" }]);
    expect(Object.keys(m.auths as any)).toHaveLength(0);
  });

  it("preserves unread auth fields on edit (no data loss)", () => {
    const imported = {
      auths: {
        primary: {
          type: "oauth2",
          authorization_endpoint: "https://x.test/authorize",
          token_endpoint: "https://x.test/token",
          authorized_uris: ["https://x.test/**"],
          userinfo_endpoint: "https://x.test/userinfo",
          identity_claims: { email: "$.email" },
          token_endpoint_auth_method: "client_secret_post",
          scope_catalog: [{ value: "read", label: "Read", implies: [] }],
          default_scopes: ["read"],
          delivery: {
            http: { in: "header", name: "Authorization", value: "{$credential.access_token}" },
          },
          _meta: { "dev.appstrate/oauth": { scope_separator: " " } },
        },
      },
    };
    // Edit one field via the form round-trip.
    const auths = getAuths(imported);
    auths[0]!.tokenEndpoint = "https://x.test/token2";
    const out = setAuths(imported, auths);
    const a = (out.auths as any).primary;
    expect(a.token_endpoint).toBe("https://x.test/token2");
    // Unread fields survive.
    expect(a.userinfo_endpoint).toBe("https://x.test/userinfo");
    expect(a.identity_claims).toEqual({ email: "$.email" });
    expect(a.token_endpoint_auth_method).toBe("client_secret_post");
    expect(a._meta).toEqual({ "dev.appstrate/oauth": { scope_separator: " " } });
    // scope_catalog.implies preserved via value-merge.
    expect(a.scope_catalog[0].implies).toEqual([]);
  });

  it("preserves delivery.env when editing delivery.http", () => {
    const imported = {
      auths: {
        primary: {
          type: "api_key",
          authorized_uris: ["https://x.test/**"],
          credentials: {
            schema: {
              type: "object",
              required: ["api_key"],
              properties: { api_key: { type: "string", description: "key" } },
            },
          },
          delivery: {
            http: { in: "header", name: "Authorization", value: "{$credential.api_key}" },
            env: { MY_TOKEN: { value: "{$credential.api_key}" } },
          },
        },
      },
    };
    const auths = getAuths(imported);
    auths[0]!.deliveryHeaderName = "X-Api-Key";
    const out = setAuths(imported, auths);
    const a = (out.auths as any).primary;
    expect(a.delivery.http.name).toBe("X-Api-Key");
    expect(a.delivery.env).toEqual({ MY_TOKEN: { value: "{$credential.api_key}" } });
    // credential property description preserved.
    expect(a.credentials.schema.properties.api_key.description).toBe("key");
  });
});

describe("integration-editor tools_policy", () => {
  it("round-trips a tool policy entry", () => {
    const m = setToolsPolicy({}, [
      {
        name: "list_issues",
        requiredScopes: { primary: ["read"], pat: [] },
      },
    ]);
    const tp = (m.tools_policy as any).list_issues;
    // Empty per-auth arrays are dropped; only non-empty kept.
    expect(tp.required_scopes).toEqual({ primary: ["read"] });

    const back = getToolsPolicy(m)[0]!;
    expect(back.name).toBe("list_issues");
    expect(back.requiredScopes).toEqual({ primary: ["read"] });
  });

  it("removes tools_policy entirely when the list is empty", () => {
    const m = setToolsPolicy({ tools_policy: { x: {} } }, []);
    expect(m.tools_policy).toBeUndefined();
  });
});

describe("integration-editor allow_undeclared_tools (§7.8)", () => {
  it("getAllowUndeclaredTools returns false when absent or false", () => {
    expect(getAllowUndeclaredTools({})).toBe(false);
    expect(getAllowUndeclaredTools({ allow_undeclared_tools: false })).toBe(false);
  });

  it("getAllowUndeclaredTools returns true only for the literal `true` value", () => {
    expect(getAllowUndeclaredTools({ allow_undeclared_tools: true })).toBe(true);
    // Defensive: a truthy non-`true` value MUST NOT flip the flag on.
    expect(getAllowUndeclaredTools({ allow_undeclared_tools: "true" })).toBe(false);
    expect(getAllowUndeclaredTools({ allow_undeclared_tools: 1 })).toBe(false);
  });

  it("setAllowUndeclaredTools writes the flag on truthy and strips it on false", () => {
    const enabled = setAllowUndeclaredTools({ name: "@x/y" }, true);
    expect(enabled.allow_undeclared_tools).toBe(true);

    const disabled = setAllowUndeclaredTools(enabled, false);
    expect(disabled).not.toHaveProperty("allow_undeclared_tools");
  });
});
