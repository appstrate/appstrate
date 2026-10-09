// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type {
  IntegrationManifestAuth,
  IntegrationManifestView,
} from "../../../hooks/use-integrations";
import {
  requestedScopes,
  scopeChoiceFor,
  scopesForAgent,
  tickAgentScopes,
} from "../connect-scope-choice";

const GOOGLE = {
  type: "oauth2",
  default_scopes: ["openid", "gmail.readonly"],
  scope_catalog: [
    { value: "openid", label: "Identité" },
    { value: "gmail.readonly", label: "Lire les courriels" },
    { value: "gmail.compose", label: "Rédiger des brouillons" },
    { value: "gmail.send", label: "Envoyer des courriels" },
  ],
} as unknown as IntegrationManifestAuth;

const MANIFEST = {
  auths: { google: GOOGLE },
  tools_policy: {
    send_email: { required_scopes: { google: ["gmail.send"] } },
    read_email: { required_scopes: { google: ["gmail.readonly"] } },
  },
} as unknown as IntegrationManifestView;

function choice() {
  const c = scopeChoiceFor(GOOGLE);
  if (!c) throw new Error("expected a choice");
  return c;
}

describe("scopeChoiceFor", () => {
  it("splits the catalog into the default baseline and the rest", () => {
    const c = choice();
    expect(c.baseline).toEqual(["openid", "gmail.readonly"]);
    expect(c.selectable.map((e) => e.value)).toEqual(["gmail.compose", "gmail.send"]);
  });

  it("leaves out of the baseline a default that another default implies", () => {
    const c = scopeChoiceFor({
      ...GOOGLE,
      default_scopes: ["email", "userinfo.email", "gmail.readonly"],
      scope_catalog: [
        { value: "email", label: "Adresse e-mail" },
        { value: "userinfo.email", label: "Adresse e-mail (Google)", implies: ["email"] },
        ...(GOOGLE.scope_catalog ?? []),
      ],
    });
    expect(c?.baseline).toEqual(["userinfo.email", "gmail.readonly"]);
    expect(c?.selectable.map((e) => e.value)).not.toContain("email");
  });

  it("offers no choice for a non-oauth2 auth", () => {
    expect(scopeChoiceFor({ type: "api_key" } as unknown as IntegrationManifestAuth)).toBeNull();
    expect(scopeChoiceFor(undefined)).toBeNull();
  });

  it("offers no choice without a catalog", () => {
    const noCatalog = { ...GOOGLE, scope_catalog: undefined };
    expect(scopeChoiceFor(noCatalog as unknown as IntegrationManifestAuth)).toBeNull();
  });

  it("offers no choice when every catalog scope is a default", () => {
    const allDefaults = {
      ...GOOGLE,
      default_scopes: (GOOGLE.scope_catalog ?? []).map((e) => e.value),
    };
    expect(scopeChoiceFor(allDefaults as unknown as IntegrationManifestAuth)).toBeNull();
  });
});

describe("scopesForAgent", () => {
  it("ticks the selectable scopes the agent's tools need, never the baseline", () => {
    expect(
      scopesForAgent(choice(), {
        manifest: MANIFEST,
        authKey: "google",
        agent: { tools: ["read_email", "send_email"] },
      }),
    ).toEqual(["gmail.send"]);
  });

  it("adds the agent's explicit scopes", () => {
    expect(
      scopesForAgent(choice(), {
        manifest: MANIFEST,
        authKey: "google",
        agent: { tools: ["read_email"], scopes: ["gmail.compose"] },
      }),
    ).toEqual(["gmail.compose"]);
  });

  it("ticks nothing for an agent the baseline already covers", () => {
    expect(
      scopesForAgent(choice(), {
        manifest: MANIFEST,
        authKey: "google",
        agent: { tools: ["read_email"] },
      }),
    ).toEqual([]);
  });
});

describe("tickAgentScopes", () => {
  const INTEGRATION = "@acme/gmail";

  function pick(
    integrations: { id: string; tools?: string[]; scopes?: string[] }[],
    ticked: string[] = [],
  ) {
    const loaded: string[] = [];
    return tickAgentScopes({
      loadAgent: async () => {
        loaded.push("agent");
        return { dependencies: { integrations } };
      },
      integrationId: INTEGRATION,
      manifest: MANIFEST,
      authKey: "google",
      choice: choice(),
      ticked,
    }).then((result) => ({ ...result, loaded }));
  }

  it("reads the agent and ticks the scopes its entry for this integration needs", async () => {
    const result = await pick([
      { id: "@acme/other", tools: ["send_email"], scopes: ["gmail.compose"] },
      { id: INTEGRATION, tools: ["send_email"] },
    ]);
    expect(result).toEqual({ ticked: ["gmail.send"], added: true, loaded: ["agent"] });
  });

  it("adds to what is already ticked", async () => {
    const result = await pick([{ id: INTEGRATION, tools: ["send_email"] }], ["gmail.compose"]);
    expect(result.ticked).toEqual(["gmail.compose", "gmail.send"]);
    expect(result.added).toBe(true);
  });

  it("adds nothing for an agent the baseline covers", async () => {
    const result = await pick([{ id: INTEGRATION, tools: ["read_email"] }]);
    expect(result).toMatchObject({ ticked: [], added: false });
  });

  it("adds nothing when the definition read does not declare the integration", async () => {
    const result = await pick([{ id: "@acme/other", tools: ["send_email"] }], ["gmail.compose"]);
    expect(result).toMatchObject({ ticked: ["gmail.compose"], added: false });
  });

  it("adds nothing when everything the agent needs is already ticked", async () => {
    const result = await pick([{ id: INTEGRATION, tools: ["send_email"] }], ["gmail.send"]);
    expect(result).toMatchObject({ ticked: ["gmail.send"], added: false });
  });
});

describe("requestedScopes", () => {
  it("sends the ticked scopes in catalog order", () => {
    expect(requestedScopes(choice(), ["gmail.send", "gmail.compose"])).toEqual([
      "gmail.compose",
      "gmail.send",
    ]);
  });

  it("sends nothing when nothing is ticked: the baseline alone", () => {
    expect(requestedScopes(choice(), [])).toEqual([]);
  });

  it("drops a value outside the selectable set", () => {
    expect(requestedScopes(choice(), ["openid", "gmail.send", "unknown"])).toEqual(["gmail.send"]);
  });
});
