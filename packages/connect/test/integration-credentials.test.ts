// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the multi-auth integration credential resolver. All
 * test inputs are pure data; no DB or network involved.
 */

import { describe, it, expect } from "bun:test";
import {
  ALIAS_MAP,
  resolveIntegrationCredentials,
  readCredentialField,
  resolveHttpDelivery,
  resolveEnvDelivery,
  resolveFilesDelivery,
  routeRequestToAuth,
  type AuthCredentialBundle,
  type IntegrationCredentialsPayload,
} from "../src/integration-credentials.ts";
import { integrationManifestSchema, type IntegrationManifest } from "@appstrate/core/integration";

// Helper to build a minimum-viable manifest then auth-merge overrides.
function manifest(authsOverrides: Record<string, unknown>): IntegrationManifest {
  const raw = {
    manifestVersion: "1.1",
    type: "integration",
    name: "@official/gmail",
    version: "1.0.0",
    displayName: "Gmail",
    server: { type: "node", entryPoint: "./server/index.js" },
    auths: authsOverrides,
  };
  const parsed = integrationManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fixture invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

describe("ALIAS_MAP / readCredentialField — manifest aliases", () => {
  it("looks up the camelCase manifest name against snake_case storage", () => {
    expect(readCredentialField({ access_token: "tok" }, "accessToken")).toBe("tok");
  });

  it("looks up the snake_case storage name against camelCase storage", () => {
    expect(readCredentialField({ accessToken: "tok" }, "access_token")).toBe("tok");
  });

  it("returns the direct hit when both shapes are present (no alias chase)", () => {
    expect(readCredentialField({ access_token: "snake" }, "access_token")).toBe("snake");
  });

  it("returns undefined when neither shape is set", () => {
    expect(readCredentialField({}, "accessToken")).toBeUndefined();
  });

  it("covers every documented alias from ALIAS_MAP", () => {
    for (const [camel, snake] of Object.entries(ALIAS_MAP)) {
      expect(readCredentialField({ [snake]: "v" }, camel)).toBe("v");
      expect(readCredentialField({ [camel]: "v" }, snake)).toBe("v");
    }
  });
});

describe("resolveIntegrationCredentials — multi-auth", () => {
  it("returns one entry per connected auth, preserving manifest order", () => {
    const m = manifest({
      github: {
        type: "oauth2",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        authorizedUris: ["https://api.github.com/*"],
        delivery: { http: {} },
      },
      linear: {
        type: "oauth2",
        authorizationUrl: "https://linear.app/oauth/authorize",
        tokenUrl: "https://api.linear.app/oauth/token",
        authorizedUris: ["https://api.linear.app/*"],
        delivery: { http: {} },
      },
      slack: {
        type: "oauth2",
        required: false,
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        authorizedUris: ["https://slack.com/api/*"],
        delivery: { http: {} },
      },
    });

    const bundles: Record<string, AuthCredentialBundle> = {
      github: { fields: { access_token: "gh-tok" } },
      linear: { fields: { access_token: "ln-tok" } },
    };

    const out = resolveIntegrationCredentials(m, bundles);
    expect(out.auths.map((a) => a.authKey)).toEqual(["github", "linear"]);
    expect(out.missingRequiredAuthKeys).toEqual([]);
    expect(out.auths[0]!.fields["access_token"]).toBe("gh-tok");
    expect(out.auths[1]!.fields["access_token"]).toBe("ln-tok");
  });

  it("flags missing required auths in missingRequiredAuthKeys", () => {
    const m = manifest({
      github: {
        type: "oauth2",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        authorizedUris: ["https://api.github.com/*"],
        delivery: { http: {} },
      },
      slack: {
        type: "oauth2",
        required: false,
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        authorizedUris: ["https://slack.com/api/*"],
        delivery: { http: {} },
      },
    });

    const out = resolveIntegrationCredentials(m, {});
    expect(out.auths).toEqual([]);
    expect(out.missingRequiredAuthKeys).toEqual(["github"]);
  });

  it("passes through audience, identityClaims, expiresAt, scopesGranted", () => {
    const m = manifest({
      primary: {
        type: "oauth2",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        audience: "https://gmail.googleapis.com",
        authorizedUris: ["https://gmail.googleapis.com/*"],
        delivery: { http: {} },
      },
    });

    const out = resolveIntegrationCredentials(m, {
      primary: {
        fields: { access_token: "tok" },
        identityClaims: { account_email: "pierre@example.com" },
        expiresAt: "2026-05-17T11:00:00Z",
        scopesGranted: ["gmail.send"],
      },
    });

    expect(out.auths[0]!.audience).toBe("https://gmail.googleapis.com");
    expect(out.auths[0]!.identityClaims?.["account_email"]).toBe("pierre@example.com");
    expect(out.auths[0]!.expiresAt).toBe("2026-05-17T11:00:00Z");
    expect(out.auths[0]!.scopesGranted).toEqual(["gmail.send"]);
  });

  it("freezes fields and authorizedUris on the output (no mutation by callers)", () => {
    const m = manifest({
      primary: {
        type: "oauth2",
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        authorizedUris: ["https://api.example.com/*"],
        delivery: { http: {} },
      },
    });
    const out = resolveIntegrationCredentials(m, {
      primary: { fields: { access_token: "tok" } },
    });
    expect(Object.isFrozen(out.auths[0]!.fields)).toBe(true);
    expect(Object.isFrozen(out.auths[0]!.authorizedUris)).toBe(true);
  });
});

describe("resolveHttpDelivery — defaults per auth type", () => {
  it("oauth2 → Authorization: Bearer <accessToken>", () => {
    const plan = resolveHttpDelivery("oauth2", { access_token: "tok" }, {});
    expect(plan).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      value: "tok",
      allowServerOverride: false,
    });
  });

  it("api_key → X-Api-Key: <apiKey>", () => {
    const plan = resolveHttpDelivery("api_key", { api_key: "k" }, {});
    expect(plan).toEqual({
      headerName: "X-Api-Key",
      headerPrefix: "",
      value: "k",
      allowServerOverride: false,
    });
  });

  it("basic → Authorization: Basic <base64(user:pass)>", () => {
    const plan = resolveHttpDelivery("basic", { username: "u", password: "p" }, {});
    expect(plan!.headerName).toBe("Authorization");
    expect(plan!.headerPrefix).toBe("Basic ");
    expect(plan!.value).toBe(Buffer.from("u:p", "utf8").toString("base64"));
  });

  it("custom with no http config → null (proxy injects nothing)", () => {
    const plan = resolveHttpDelivery("custom", {}, {});
    expect(plan).toBeNull();
  });
});

describe("resolveHttpDelivery — explicit overrides", () => {
  it("respects explicit headerName / headerPrefix / valueFrom", () => {
    const plan = resolveHttpDelivery(
      "oauth2",
      { access_token: "tok" },
      { headerName: "X-Token", headerPrefix: "Token ", valueFrom: "accessToken" },
    );
    expect(plan).toEqual({
      headerName: "X-Token",
      headerPrefix: "Token ",
      value: "tok",
      allowServerOverride: false,
    });
  });

  it("renders template valueFrom with {{var}} substitution and base64 encoding", () => {
    const plan = resolveHttpDelivery(
      "api_key",
      { email: "pierre@example.com", api_token: "abc123" },
      {
        valueFrom: { template: "{{email}}/token:{{api_token}}", encoding: "base64" },
      },
    );
    expect(plan!.value).toBe(
      Buffer.from("pierre@example.com/token:abc123", "utf8").toString("base64"),
    );
  });

  it("template with missing placeholder renders empty for that ref (not the literal)", () => {
    const plan = resolveHttpDelivery(
      "api_key",
      { email: "pierre@example.com" },
      { valueFrom: { template: "{{email}}/{{api_token}}" } },
    );
    expect(plan!.value).toBe("pierre@example.com/");
  });

  it("allowServerOverride flag is reflected in the plan", () => {
    const plan = resolveHttpDelivery(
      "oauth2",
      { access_token: "tok" },
      { allowServerOverride: true },
    );
    expect(plan!.allowServerOverride).toBe(true);
  });
});

describe("resolveEnvDelivery", () => {
  it("resolves each env entry via alias-aware field lookup", () => {
    const out = resolveEnvDelivery(
      {
        GMAIL_TOKEN: { from: "accessToken", sensitive: true },
        GMAIL_USER: { from: "accountEmail" },
      },
      { access_token: "tok" },
      { account_email: "pierre@example.com" },
    );

    expect(out).toEqual([
      { name: "GMAIL_TOKEN", value: "tok", sensitive: true },
      { name: "GMAIL_USER", value: "pierre@example.com", sensitive: false },
    ]);
  });

  it("missing references render as empty string", () => {
    const out = resolveEnvDelivery({ X: { from: "doesNotExist" } }, {});
    expect(out).toEqual([{ name: "X", value: "", sensitive: false }]);
  });

  it("template references in `from` are rendered against fields + identityClaims", () => {
    const out = resolveEnvDelivery(
      { CONNSTR: { from: "user={{username}};email={{accountEmail}}" } },
      { username: "alice" },
      { account_email: "alice@example.com" },
    );
    expect(out[0]!.value).toBe("user=alice;email=alice@example.com");
  });
});

describe("resolveFilesDelivery", () => {
  it("defaults mode to 0400 when unset", () => {
    const out = resolveFilesDelivery(
      { "/run/afps/gmail-creds.json": { from: "credentialsJson" } },
      { credentials_json: '{"k":"v"}' },
    );
    expect(out).toEqual([
      { path: "/run/afps/gmail-creds.json", content: '{"k":"v"}', mode: "0400" },
    ]);
  });

  it("preserves explicit mode", () => {
    const out = resolveFilesDelivery(
      { "/etc/kube/config": { from: "kubeconfig", mode: "0600" } },
      { kubeconfig: "apiVersion: v1" },
    );
    expect(out[0]!.mode).toBe("0600");
  });
});

describe("routeRequestToAuth", () => {
  function payload(): IntegrationCredentialsPayload {
    return {
      auths: [
        {
          authKey: "github",
          authType: "oauth2",
          fields: { access_token: "gh" },
          authorizedUris: ["https://api.github.com/**"],
        },
        {
          authKey: "linear",
          authType: "oauth2",
          fields: { access_token: "ln" },
          authorizedUris: ["https://api.linear.app/**"],
        },
        {
          authKey: "shared",
          authType: "oauth2",
          fields: { access_token: "sh" },
          authorizedUris: ["https://api.github.com/repos/**"],
        },
      ],
      missingRequiredAuthKeys: [],
    };
  }

  it("returns the first auth whose authorizedUris matches (manifest order)", () => {
    // `github` appears first and matches the URL too — even though `shared`
    // would also match, manifest order wins per §4.1.4 step 1.
    const auth = routeRequestToAuth("https://api.github.com/repos/anthropic/claude", payload());
    expect(auth?.authKey).toBe("github");
  });

  it("returns null when no auth matches", () => {
    expect(routeRequestToAuth("https://api.example.com/", payload())).toBeNull();
  });

  it("matches the multi-segment glob pattern", () => {
    const auth = routeRequestToAuth("https://api.linear.app/graphql", payload());
    expect(auth?.authKey).toBe("linear");
  });
});

describe("end-to-end — Gmail-like fixture from the proposal", () => {
  it("resolves the full payload, http delivery, and routing in one pass", () => {
    const m = manifest({
      primary: {
        type: "oauth2",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        audience: "https://gmail.googleapis.com",
        scopes: ["gmail.send", "gmail.readonly"],
        extractTokenIdentity: { email: "$.id_token.email", accountId: "$.id_token.sub" },
        authorizedUris: ["https://gmail.googleapis.com/**", "https://www.googleapis.com/gmail/**"],
        delivery: {
          http: { headerName: "Authorization", headerPrefix: "Bearer ", valueFrom: "accessToken" },
          env: {
            GMAIL_TOKEN: { from: "accessToken", sensitive: true },
            GMAIL_USER: { from: "accountEmail" },
          },
        },
      },
    });

    const out = resolveIntegrationCredentials(m, {
      primary: {
        fields: { access_token: "ya29.tok" },
        identityClaims: { account_email: "pierre@gmail.com", account_id: "12345" },
        scopesGranted: ["gmail.send", "gmail.readonly"],
      },
    });
    expect(out.missingRequiredAuthKeys).toEqual([]);

    const auth = routeRequestToAuth("https://gmail.googleapis.com/gmail/v1/users/me/messages", out);
    expect(auth?.authKey).toBe("primary");
    expect(auth?.audience).toBe("https://gmail.googleapis.com");

    const httpPlan = resolveHttpDelivery(
      auth!.authType,
      auth!.fields,
      m.auths!.primary!.delivery.http!,
    );
    expect(httpPlan).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      value: "ya29.tok",
      allowServerOverride: false,
    });

    const envPlan = resolveEnvDelivery(
      m.auths!.primary!.delivery.env!,
      auth!.fields,
      auth!.identityClaims,
    );
    expect(envPlan).toEqual([
      { name: "GMAIL_TOKEN", value: "ya29.tok", sensitive: true },
      { name: "GMAIL_USER", value: "pierre@gmail.com", sensitive: false },
    ]);
  });
});
