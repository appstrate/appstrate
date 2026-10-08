// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { ApiError } from "@appstrate/core/api-errors";
import {
  authUrlTemplates,
  resolveConnectionVariables,
  type ConnectionVariablesDeps,
} from "../../src/services/connect/connection-variables.ts";
import type { AfpsManifestAuth } from "../../src/services/integration-manifest-helpers.ts";

const forgeManifest = {
  type: "integration",
  name: "@test/forge",
  version: "1.0.0",
  source: {
    kind: "remote",
    remote: { url: "{$variable.base_url}/api/v4/mcp", transport: "streamable-http" },
  },
  variables: {
    schema: {
      type: "object",
      properties: { base_url: { type: "string", pattern: "^https?://" } },
      required: ["base_url"],
    },
  },
  auths: {},
} as unknown as IntegrationManifest;

const oauthAuth = {
  type: "oauth2",
  issuer: "{$variable.base_url}",
  token_endpoint_auth_method: "none",
  authorized_uris: ["{$variable.base_url}/api/v4/**"],
  delivery: { http: { in: "header", name: "Authorization", value: "{$credential.access_token}" } },
} as unknown as AfpsManifestAuth;

const tenantManifest = {
  ...forgeManifest,
  source: { kind: "local", server: { name: "@test/server", version: "1.0.0" } },
  variables: {
    schema: {
      type: "object",
      properties: { tenant: { type: "string" } },
      required: ["tenant"],
    },
  },
} as unknown as IntegrationManifest;

const tenantAuth = {
  type: "api_key",
  authorized_uris: ["https://{$variable.tenant}.example.com/**"],
  delivery: { http: { in: "header", name: "X-Key", value: "{$credential.api_key}" } },
} as unknown as AfpsManifestAuth;

const allowAll: ConnectionVariablesDeps = { isEgressAllowed: async () => true };

async function fieldErrors(
  promise: Promise<unknown>,
): Promise<Array<{ field: string; code: string }>> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("validation_failed");
  return ((err as ApiError).fieldErrors ?? []).map(({ field, code }) => ({ field, code }));
}

describe("resolveConnectionVariables (AFPS §7.12)", () => {
  it("returns the submitted values when they validate, render and pass egress", async () => {
    const egressed: string[] = [];
    const values = await resolveConnectionVariables(
      forgeManifest,
      oauthAuth,
      { base_url: "https://forge.example.com/" },
      {
        isEgressAllowed: async (url) => {
          egressed.push(url);
          return true;
        },
      },
    );
    expect(values).toEqual({ base_url: "https://forge.example.com/" });
    // The remote URL and the issuer, rendered.
    expect(egressed).toEqual([
      "https://forge.example.com/api/v4/mcp",
      "https://forge.example.com/",
    ]);
  });

  it("returns null for an integration that declares none and receives none", async () => {
    const manifest = { ...forgeManifest, variables: undefined } as unknown as IntegrationManifest;
    expect(await resolveConnectionVariables(manifest, tenantAuth, undefined, allowAll)).toBeNull();
  });

  it("refuses variables for an integration that declares none", async () => {
    const manifest = { ...forgeManifest, variables: undefined } as unknown as IntegrationManifest;
    expect(
      await fieldErrors(resolveConnectionVariables(manifest, tenantAuth, { x: "y" }, allowAll)),
    ).toEqual([{ field: "variables", code: "variables_not_declared" }]);
  });

  it("refuses missing variables", async () => {
    const errors = await fieldErrors(
      resolveConnectionVariables(forgeManifest, oauthAuth, undefined, allowAll),
    );
    expect(errors).toEqual([{ field: "variables.base_url", code: "invalid_variable" }]);
  });

  it("refuses an undeclared variable and a value its schema refuses", async () => {
    const errors = await fieldErrors(
      resolveConnectionVariables(
        forgeManifest,
        oauthAuth,
        { base_url: "ftp://forge.example.com", extra: "x" },
        allowAll,
      ),
    );
    expect(errors).toContainEqual({ field: "variables.extra", code: "unknown_variable" });
    expect(errors).toContainEqual({ field: "variables.base_url", code: "invalid_variable" });
  });

  it("refuses a value that leaves a URL template unrenderable (query, userinfo)", async () => {
    for (const base_url of ["https://forge.example.com?x=1", "https://u:p@forge.example.com"]) {
      expect(
        await fieldErrors(
          resolveConnectionVariables(forgeManifest, oauthAuth, { base_url }, allowAll),
        ),
      ).toContainEqual({ field: "variables.base_url", code: "unrenderable_variable" });
    }
  });

  it("refuses a value whose rendered URL the egress controls refuse", async () => {
    const errors = await fieldErrors(
      resolveConnectionVariables(
        forgeManifest,
        oauthAuth,
        { base_url: "https://169.254.169.254" },
        { isEgressAllowed: async () => false },
      ),
    );
    expect(errors).toEqual([{ field: "variables.base_url", code: "egress_blocked" }]);
  });

  it("refuses a value that leaves an authorized_uris entry unrenderable", async () => {
    const errors = await fieldErrors(
      resolveConnectionVariables(tenantManifest, tenantAuth, { tenant: "a.b-" }, allowAll),
    );
    expect(errors).toEqual([{ field: "variables.tenant", code: "unrenderable_variable" }]);
    expect(
      await resolveConnectionVariables(tenantManifest, tenantAuth, { tenant: "Acme" }, allowAll),
    ).toEqual({ tenant: "Acme" });
  });

  it("checks the real egress guard by default (a link-local URL is refused)", async () => {
    const errors = await fieldErrors(
      resolveConnectionVariables(forgeManifest, oauthAuth, { base_url: "https://169.254.169.254" }),
    );
    expect(errors).toContainEqual({ field: "variables.base_url", code: "egress_blocked" });
  });
});

describe("authUrlTemplates", () => {
  it("lists the templated URLs choosing an auth's upstream", () => {
    expect(authUrlTemplates(forgeManifest, oauthAuth)).toEqual([
      "{$variable.base_url}/api/v4/mcp",
      "{$variable.base_url}",
    ]);
    expect(authUrlTemplates(tenantManifest, tenantAuth)).toEqual([]);
  });
});
