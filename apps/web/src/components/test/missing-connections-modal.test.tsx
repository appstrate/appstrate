// SPDX-License-Identifier: Apache-2.0

/**
 * The recovery modal of a refused launch. Its dialog chrome is a Radix
 * portal, which renders nothing without a DOM, so a row is rendered through
 * `MissingRow`; the Re-run button's state is `retryDecision`, tested with its module.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { render } from "../../test/render.tsx";
import { MissingRow } from "../missing-connections-modal.tsx";
import type { MissingIntegrationFieldError } from "../../lib/connection-choice.ts";
import { refusalMessage } from "../../lib/mutation-error.ts";
import { spaceStore } from "../../stores/space-store.ts";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

type Resolution = components["schemas"]["IntegrationAgentResolution"];

const INTEGRATION = "@acme/slack";
const AGENT = "@acme/ops";
const WEB = "11111111-1111-4111-8111-111111111111";

type Code = MissingIntegrationFieldError["code"];

const fieldError = (code: Code): MissingIntegrationFieldError => ({
  field: `integrations.${INTEGRATION}`,
  code,
  message: code,
});

function resolution(overrides: Partial<Resolution>): Resolution {
  return {
    source: null,
    error_code: null,
    warning: null,
    resolved_connection_ids: [],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
    org_default_connection_ids: null,
    org_default_enforced: false,
    can_add_connection: true,
    candidates: [],
    ...overrides,
  };
}

const readinessKey = (version?: string, spaceId?: string) =>
  $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
    params: {
      path: { scope: "@acme", name: "ops" },
      ...(version ? { query: { version } } : {}),
      header: { "X-Org-Id": undefined, "X-Space-Id": spaceId },
    },
  }).queryKey;

const readiness = (res: Resolution, runBlocking: boolean) => ({
  blocks_run: runBlocking,
  errors: [],
  integrations: [
    {
      integration_package_id: INTEGRATION,
      required: false,
      run_blocking: runBlocking,
      inert: false,
      resolution: res,
    },
  ],
});

type Warning = NonNullable<Resolution["warning"]>;
const warning = (code: Warning["code"], over: Partial<Warning> = {}): Warning => ({
  field: `integrations.${INTEGRATION}`,
  code,
  message: code,
  ...over,
});

const UNBOUND = resolution({ warning: warning("not_connected") });
const BLOCKED = resolution({ error_code: "must_choose_connection" });
const label = (key: string) => i18n.t(`agents:${key}`);

function renderRow(
  qc: QueryClient,
  version?: string,
  code: Code = "must_choose_connection",
): string {
  return render(
    <MissingRow
      err={fieldError(code)}
      agentPackageId={AGENT}
      version={version}
      integrationEntries={undefined}
    />,
    { queryClient: qc },
  );
}

describe("MissingRow", () => {
  it("reads the verdict of the version the refused launch ran, not the draft's", () => {
    const qc = new QueryClient();
    qc.setQueryData(readinessKey(), readiness(BLOCKED, true));
    qc.setQueryData(readinessKey("published"), readiness(UNBOUND, false));
    const refusal = refusalMessage(fieldError("must_choose_connection"))!;
    const published = renderRow(qc, "published");
    expect(published).toContain(label("detail.integrationUnbound"));
    expect(published).not.toContain(refusal);
    // Control: the draft still blocks, so its row keeps the refusal.
    const draft = renderRow(qc);
    expect(draft).toContain(refusal);
    expect(draft).not.toContain(label("detail.integrationUnbound"));
  });

  it("keeps the resolver's own message for an item code this build has no sentence for", () => {
    const html = render(
      <MissingRow
        err={{
          field: `integrations.${INTEGRATION}`,
          code: "code_from_a_newer_server" as Code,
          message: "The resolver explains this one.",
        }}
        agentPackageId={AGENT}
        version={undefined}
        integrationEntries={undefined}
      />,
      { queryClient: new QueryClient() },
    );
    expect(html).toContain("The resolver explains this one.");
  });

  it("names why an optional integration runs without, ahead of the resolved header", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      readinessKey(),
      readiness(
        resolution({
          warning: warning("integration_unbound", { source: "member_pin" }),
          member_pinned_connection_ids: [],
        }),
        false,
      ),
    );
    const html = renderRow(qc);
    expect(html).toContain(
      i18n.t("agents:detail.integrationUnboundNoneBy", {
        by: label("noneChosenBy.memberPin"),
      }),
    );
    expect(html).not.toContain(label("missingConnections.resolved"));
  });

  it("says resolved once the integration binds", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      readinessKey(),
      readiness(resolution({ resolved_connection_ids: [WEB] }), false),
    );
    expect(renderRow(qc)).toContain(label("missingConnections.resolved"));
  });

  it("embeds the picker of the member's pin, as the Connexions tab does", () => {
    const SPACE = "spc_1";
    const scope = { "X-Org-Id": undefined, "X-Space-Id": SPACE };
    const qc = new QueryClient();
    // The row's reads gate on `integrations:read`, granted here in the current space.
    const spacesKey = $api.queryOptions("get", "/api/spaces", {
      params: { header: { "X-Org-Id": undefined } },
    }).queryKey;
    qc.setQueryData(spacesKey, {
      object: "list",
      data: [{ id: SPACE, permissions: ["integrations:read"] }],
      hasMore: false,
    });
    const detailKey = $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId: INTEGRATION }, header: scope },
    }).queryKey;
    qc.setQueryData(detailKey, {
      manifest: { display_name: "Slack", auths: { primary: { type: "custom" } } },
      auths: [],
    });
    qc.setQueryData(
      readinessKey(undefined, SPACE),
      readiness(
        resolution({
          source: "member_pin",
          resolved_connection_ids: [WEB],
          member_pinned_connection_ids: [WEB],
          candidates: [
            {
              id: WEB,
              auth_key: "primary",
              account_id: "root@web",
              label: "compte-web",
              owner_user_id: "usr_me",
              owner_end_user_id: null,
              owner_name: "Moi",
              scopes_granted: [],
              scope: "org",
              spaceId: null,
              shared_here: false,
              shared_space_ids: [],
              origin_space_id: null,
              needs_reconnection: false,
              missing_scopes: [],
              scope_fit: "unjudged",
              is_own: true,
            },
          ],
        }),
        false,
      ),
    );
    // `renderToStaticMarkup` reads zustand's server snapshot, not its live state.
    const snapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: SPACE,
    });
    try {
      const html = renderRow(qc);
      expect(html).toContain(`data-testid="member-picker-${INTEGRATION}"`);
      // The trigger names the stored pin as a pick; an override picker, unset, marks it the default.
      expect(html).toContain("compte-web");
      expect(html).not.toContain(label("detail.integrationMemberPicker.defaultBadge"));
    } finally {
      snapshot.mockRestore();
    }
  });
});
