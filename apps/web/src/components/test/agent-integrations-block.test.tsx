// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's integration card against its readiness entry: a "Requise" badge
 * for an integration the agent requires, and — for one the run starts without —
 * why: switched off in the space, a pin to none (whose), connections on another
 * auth method, only other members' shared connections, or nothing usable. Switched off reads as blocking only
 * for a required integration.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AgentIntegrationsBlock } = await import("../package-detail/agent-integrations-block.tsx");
const { $api } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const i18n = i18nModule.default;

type Resolution = components["schemas"]["IntegrationAgentResolution"];
type Candidate = Resolution["candidates"][number];

const GMAIL = "@acme/gmail";
const AGENT = "@acme/mailer";
const header = { "X-Org-Id": undefined, "X-Space-Id": undefined };

function candidate(isOwn: boolean): Candidate {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    auth_key: "oauth",
    account_id: "team@acme.test",
    label: "Équipe",
    owner_user_id: isOwn ? "usr_me" : "usr_other",
    owner_end_user_id: null,
    owner_name: isOwn ? "Moi" : "Bob",
    scopes_granted: [],
    shared_with_org: !isOwn,
    needs_reconnection: false,
    missing_scopes: [],
    is_own: isOwn,
  };
}

/** Nothing binds and nothing refuses: the run starts without Gmail. */
function unbound(over: Partial<Resolution> = {}): Resolution {
  return {
    source: null,
    error_code: null,
    warning_code: "integration_unbound",
    required_auth_key: null,
    available_auth_keys: [],
    resolved_connection_ids: [],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
    org_default_connection_ids: [],
    org_default_enforced: false,
    can_add_connection: true,
    candidates: [],
    ...over,
  };
}

function renderCard(
  resolution: Resolution,
  entry: { required?: boolean; blocking?: boolean; active?: boolean } = {},
): string {
  const qc = new QueryClient();
  qc.setQueryData($api.queryOptions("get", "/api/integrations", { params: { header } }).queryKey, {
    object: "list",
    data: [{ id: GMAIL, active: entry.active ?? true, manifest: { display_name: "Gmail" } }],
    hasMore: false,
  });
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId: GMAIL }, header },
    }).queryKey,
    { manifest: { display_name: "Gmail", auths: { oauth: { type: "oauth2" } } }, auths: [] },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
      params: { path: { scope: "@acme", name: "mailer" }, header },
    }).queryKey,
    {
      blocks_run: entry.blocking ?? false,
      errors: [],
      integrations: [
        {
          integration_package_id: GMAIL,
          required: entry.required ?? false,
          run_blocking: entry.blocking ?? false,
          resolution,
        },
      ],
    },
  );
  return render(
    <AgentIntegrationsBlock
      entries={[
        {
          id: GMAIL,
          version: "1.0.0",
          tools: undefined,
          scopes: undefined,
          required: entry.required ?? false,
        },
      ]}
      agentPackageId={AGENT}
    />,
    { queryClient: qc },
  );
}

const label = (key: string) => i18n.t(`agents:detail.${key}`);

describe("AgentIntegrationsBlock — required", () => {
  it("badges an integration the agent requires, and only that one", () => {
    const blocked = renderCard(unbound({ error_code: "required_integration_unbound" }), {
      required: true,
      blocking: true,
    });
    expect(blocked).toContain(`integration-required-${GMAIL}`);
    expect(blocked).toContain(label("integrationRequiredBadge"));
    // A refused run is no unbound state: the picker's warning says it.
    expect(blocked).not.toContain(label("integrationUnbound"));
    expect(renderCard(unbound())).not.toContain(`integration-required-${GMAIL}`);
  });
});

describe("AgentIntegrationsBlock — why the run starts without it", () => {
  it("nothing usable: not connected", () => {
    const html = renderCard(unbound());
    expect(html).toContain(label("integrationUnbound"));
    expect(html).toContain(`member-picker-${GMAIL}`);
  });

  it("switched off in the space: the activation card, no picker", () => {
    const html = renderCard(unbound({ warning_code: "integration_not_active" }));
    expect(html).toContain(label("integrationUnboundInactive"));
    expect(html).toContain(`integration-activate-${GMAIL}`);
    expect(html).not.toContain(`member-picker-${GMAIL}`);
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("off in the space per the list: blocking only when the agent requires it", () => {
    const optional = renderCard(unbound({ warning_code: "integration_not_active" }), {
      active: false,
    });
    expect(optional).toContain(label("integrationUnboundInactive"));
    expect(optional).not.toContain(label("integrationInactive"));
    expect(optional).not.toContain("text-destructive");
    expect(optional).toContain(`integration-activate-${GMAIL}`);

    const required = renderCard(unbound(), { active: false, required: true, blocking: true });
    expect(required).toContain(label("integrationInactive"));
    expect(required).toContain("text-destructive");
    expect(required).toContain(`integration-activate-${GMAIL}`);
  });

  it("an admin's pin to none, over a member's", () => {
    const html = renderCard(
      unbound({ admin_pinned_connection_ids: [], member_pinned_connection_ids: [] }),
    );
    expect(html).toContain(label("integrationUnboundAdminNone"));
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("the member's own pin to none", () => {
    expect(renderCard(unbound({ member_pinned_connection_ids: [] }))).toContain(
      label("integrationUnboundMemberNone"),
    );
  });

  it("only other members' shared connections: an invitation to pick one", () => {
    const html = renderCard(unbound({ candidates: [candidate(false)] }));
    expect(html).toContain(label("integrationUnboundSharedOnly"));
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("connections on another auth method: the agent runs without them", () => {
    const html = renderCard(unbound({ required_auth_key: "oauth", available_auth_keys: ["pat"] }));
    expect(html).toContain(label("integrationUnboundOtherAuth"));
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("says nothing of the kind while a connection binds", () => {
    const html = renderCard(
      unbound({
        source: "fallback_auto",
        warning_code: null,
        resolved_connection_ids: [candidate(true).id],
        candidates: [candidate(true)],
      }),
    );
    for (const key of [
      "integrationUnbound",
      "integrationUnboundAdminNone",
      "integrationUnboundMemberNone",
      "integrationUnboundOtherAuth",
      "integrationUnboundSharedOnly",
      "integrationUnboundInactive",
    ]) {
      expect(html).not.toContain(label(key));
    }
  });
});
