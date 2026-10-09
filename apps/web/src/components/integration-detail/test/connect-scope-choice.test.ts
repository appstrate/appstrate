// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type {
  IntegrationManifestAuth,
  IntegrationManifestView,
} from "../../../hooks/use-integrations";
import { agentScopes, connectPopupInput, scopeChoiceFor } from "../connect-scope-choice";

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

describe("agentScopes", () => {
  const scopesOf = (entry: Parameters<typeof agentScopes>[3]) =>
    agentScopes(choice(), MANIFEST, "google", entry);

  it("ticks the selectable scopes the agent's tools need, never the baseline", () => {
    expect(scopesOf({ tools: ["read_email", "send_email"] })).toEqual(["gmail.send"]);
  });

  it("adds the agent's explicit scopes", () => {
    const explicit = { tools: ["read_email"], scopes: ["gmail.compose"] };
    expect(scopesOf(explicit)).toEqual(["gmail.compose"]);
  });

  it("ticks nothing for an agent the baseline already covers", () => {
    expect(scopesOf({ tools: ["read_email"] })).toEqual([]);
  });

  it("ticks nothing for an agent pinned to another auth", () => {
    const pinned = { auth_key: "pat", tools: ["send_email"], scopes: ["gmail.compose"] };
    expect(scopesOf(pinned)).toEqual([]);
  });

  it("ticks for an agent pinned to this auth", () => {
    expect(scopesOf({ auth_key: "google", tools: ["send_email"] })).toEqual(["gmail.send"]);
  });
});

describe("connectPopupInput", () => {
  const target = { packageId: "@acme/gmail", authKey: "google", choice: choice() };

  it("sends no scopes when nothing is ticked: the baseline alone", () => {
    expect(connectPopupInput(target, [], false)).toEqual({
      packageId: "@acme/gmail",
      authKey: "google",
    });
  });

  it("sends the ticked scopes in catalog order", () => {
    expect(connectPopupInput(target, ["gmail.send", "gmail.compose"], false)).toEqual({
      packageId: "@acme/gmail",
      authKey: "google",
      scopes: ["gmail.compose", "gmail.send"],
    });
  });

  it("passes forceAccountSelect through", () => {
    expect(connectPopupInput(target, ["gmail.send"], true)).toEqual({
      packageId: "@acme/gmail",
      authKey: "google",
      scopes: ["gmail.send"],
      forceAccountSelect: true,
    });
  });

  it("sends no scopes for an auth without a choice", () => {
    expect(connectPopupInput({ ...target, choice: null }, [], true)).toEqual({
      packageId: "@acme/gmail",
      authKey: "google",
      forceAccountSelect: true,
    });
  });
});
