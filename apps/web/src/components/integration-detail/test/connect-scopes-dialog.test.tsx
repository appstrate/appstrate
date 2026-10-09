// SPDX-License-Identifier: Apache-2.0

/**
 * The scope form of "+ Ajouter": the `default_scopes` baseline is shown by its
 * catalog labels as always requested, the rest of the catalog is a checklist
 * left unticked, and an empty selection says it connects at the defaults.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import type { IntegrationManifestView } from "../../../hooks/use-integrations.ts";
import { ConnectScopesForm } from "../connect-scopes-dialog.tsx";
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
        { value: "gmail.send", label: "Envoyer des courriels" },
      ],
    },
  },
} as unknown as IntegrationManifestView;

function renderForm(): string {
  const choice = scopeChoiceFor(MANIFEST.auths?.google);
  if (!choice) throw new Error("expected a choice");
  return render(
    <ConnectScopesForm
      formId="f"
      packageId="@acme/gmail"
      authKey="google"
      manifest={MANIFEST}
      choice={choice}
      onSubmit={() => {}}
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
