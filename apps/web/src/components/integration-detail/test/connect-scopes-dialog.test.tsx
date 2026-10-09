// SPDX-License-Identifier: Apache-2.0

/**
 * The scope form of "+ Ajouter": the `default_scopes` baseline is shown by its
 * catalog labels as always requested, the rest of the catalog is a checklist,
 * and an empty selection says it connects at the defaults. The agent quick-fill
 * view says when a pick added nothing, and how its agent list loads or fails.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import type { IntegrationManifestView } from "../../../hooks/use-integrations.ts";
import { ConnectScopesForm } from "../connect-scopes-dialog.tsx";
import { AgentQuickFillMenu } from "../agent-quick-fill.tsx";
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
  return render(<ConnectScopesForm formId="f" onSubmit={() => {}} {...TARGET} />);
}

describe("ConnectScopesForm", () => {
  it("lists the baseline by label as always requested", () => {
    expect(renderForm()).toContain(
      i18n.t("settings:integration.auth.scopeChoice.baseline", {
        scopes: "Identité, Lire les courriels",
      }),
    );
  });

  it("offers the other catalog scopes, and says nothing ticked means the defaults", () => {
    const html = renderForm();
    expect(html).toContain('data-testid="f-gmail.send"');
    expect(html).not.toContain('data-testid="f-openid"');
    expect(html).toContain(i18n.t("settings:integration.auth.scopeChoice.defaultsOnly"));
  });
});

describe("AgentQuickFillMenu", () => {
  const AGENTS = [{ agent_package_id: "@acme/triage", display_name: "Tri" }];

  type Props = Parameters<typeof AgentQuickFillMenu>[0];

  function renderMenu(list: Partial<Props["list"]> = {}, state: Props["state"] = "idle"): string {
    return render(
      <AgentQuickFillMenu
        authKey="google"
        list={{ data: AGENTS, isLoading: false, error: null, ...list }}
        state={state}
        onPick={() => {}}
      />,
    );
  }

  it("offers the agents behind an action button", () => {
    const html = renderMenu();
    expect(html).toContain('data-testid="connect-scopes-agent-google"');
    expect(html).toContain(i18n.t("settings:integration.auth.scopeChoice.forAgentPlaceholder"));
    expect(html).not.toContain(i18n.t("settings:integration.auth.scopeChoice.nothingToAdd"));
  });

  it("says when the last pick added nothing", () => {
    expect(renderMenu({}, "nothing")).toContain(
      i18n.t("settings:integration.auth.scopeChoice.nothingToAdd"),
    );
  });

  it("says the agent list is loading, then that it failed", () => {
    expect(renderMenu({ data: [], isLoading: true })).toContain(i18n.t("common:loading"));
    const failed = renderMenu({ data: [], error: new Error("boom") });
    expect(failed).toContain('data-testid="connect-scopes-agent-google-error"');
    expect(failed).not.toContain('data-testid="connect-scopes-agent-google"');
  });

  it("renders nothing when no agent of the space declares the integration", () => {
    expect(renderMenu({ data: [] })).toBe("");
  });
});
