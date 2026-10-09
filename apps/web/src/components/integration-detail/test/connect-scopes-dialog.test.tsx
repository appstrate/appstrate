// SPDX-License-Identifier: Apache-2.0

/**
 * The scope form of "+ Ajouter": the `default_scopes` baseline is shown by its
 * catalog labels as always requested, the rest of the catalog is a checklist
 * left unticked, and an empty selection says it connects at the defaults. Its
 * submit opens the hosted connect with the ticked scopes, or none at all.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import type { IntegrationManifestView } from "../../../hooks/use-integrations.ts";
import {
  ConnectScopesForm,
  useConnectWithScopes,
  type ConnectWithScopesDeps,
} from "../connect-scopes-dialog.tsx";
import { scopeChoiceFor } from "../connect-scope-choice.ts";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const MANIFEST = {
  auths: {
    google: {
      type: "oauth2",
      default_scopes: ["openid", "gmail.readonly"],
      scope_catalog: [
        { value: "openid", label: "Identité" },
        { value: "gmail.readonly", label: "Lire les courriels" },
        { value: "gmail.compose", label: "Rédiger des brouillons" },
        { value: "gmail.send", label: "Envoyer des courriels" },
      ],
    },
  },
} as unknown as IntegrationManifestView;

const CHOICE = scopeChoiceFor(MANIFEST.auths?.google);
if (!CHOICE) throw new Error("expected a choice");
const TARGET = { packageId: "@acme/gmail", authKey: "google", manifest: MANIFEST, choice: CHOICE };

function renderForm(): string {
  return render(
    <ConnectScopesForm
      formId="f"
      agentLoading={false}
      onAgentLoading={() => {}}
      onSubmit={() => {}}
      {...TARGET}
    />,
  );
}

describe("ConnectScopesForm", () => {
  it("lists the baseline by label as always requested", () => {
    expect(renderForm()).toContain(
      i18n.t("settings:integration.auth.scopeChoice.baseline", {
        scopes: "Identité, Lire les courriels",
      }),
    );
  });

  it("offers the other catalog scopes unticked, and says nothing ticked means the defaults", () => {
    const html = renderForm();
    expect(html).toContain('data-testid="f-gmail.send"');
    expect(html).not.toContain('data-testid="f-openid"');
    expect(html).not.toContain('data-state="checked"');
    expect(html).toContain(i18n.t("settings:integration.auth.scopeChoice.defaultsOnly"));
  });
});

describe("useConnectWithScopes", () => {
  type OpenPopup = NonNullable<ConnectWithScopesDeps["openPopup"]>;

  type Connect = ReturnType<typeof useConnectWithScopes>["connect"];

  function Probe(props: {
    forceAccountSelect: boolean;
    openPopup: OpenPopup;
    onConnect: (connect: Connect) => void;
  }) {
    const { openPopup, onConnect, forceAccountSelect } = props;
    onConnect(useConnectWithScopes({ ...TARGET, forceAccountSelect }, { openPopup }).connect);
    return null;
  }

  /** The submit as the dialog sends it: the raw ticks, in the order they were made. */
  function submit(ticked: string[], forceAccountSelect: boolean) {
    const calls: Parameters<OpenPopup>[0][] = [];
    const connects: Connect[] = [];
    render(
      <Probe
        forceAccountSelect={forceAccountSelect}
        openPopup={async (input) => {
          calls.push(input);
          return true;
        }}
        onConnect={(connect) => connects.push(connect)}
      />,
    );
    const connect = connects[0];
    if (!connect) throw new Error("the hook should have rendered");
    void connect(ticked);
    return calls;
  }

  it("sends no scopes when nothing is ticked", () => {
    expect(submit([], false)).toEqual([{ packageId: "@acme/gmail", authKey: "google" }]);
  });

  it("sends the ticked scopes in catalog order", () => {
    expect(submit(["gmail.send", "gmail.compose"], false)).toEqual([
      { packageId: "@acme/gmail", authKey: "google", scopes: ["gmail.compose", "gmail.send"] },
    ]);
  });

  it("passes forceAccountSelect through", () => {
    expect(submit(["gmail.send"], true)).toEqual([
      {
        packageId: "@acme/gmail",
        authKey: "google",
        scopes: ["gmail.send"],
        forceAccountSelect: true,
      },
    ]);
  });
});
