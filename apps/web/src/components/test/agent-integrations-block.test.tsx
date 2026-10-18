// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's integration card against its readiness entry: a "Requise" badge
 * for an integration the agent requires (active or not), why a stored none
 * blocks the launch of a required one, and — for one the run starts without —
 * why: switched off in the space, a pin to none (whose), connections on another
 * auth method, only other members' shared connections, or nothing usable. Switched off reads as blocking only
 * for a required integration.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { IntegrationPin } from "@appstrate/shared-types";
import type { components } from "../../api/schema";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AgentIntegrationsBlock } = await import("../package-detail/agent-integrations-block.tsx");
const { pinRowActions } = await import("../package-detail/pin-row-actions.ts");
const { PinFormFields, PinFormModal } = await import("../integration-detail/pin-editor.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { $api } = await import("../../api/client.ts");
const { AMBER_TEXT } = await import("../integration-connect/connection-picker-states.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const { ApiError } = await import("../../api/errors.ts");
const { errorMessage } = await import("../../lib/mutation-error.ts");

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
    scope: "org",
    spaceId: null,
    // A colleague's row is read as shared (or not) into the space this request is made from.
    shared_here: !isOwn,
    ...(isOwn && { shared_space_ids: [] }),
    origin_space_id: null,
    needs_reconnection: false,
    missing_scopes: [],
    scope_fit: "unjudged",
    is_own: isOwn,
  };
}

type Warning = NonNullable<Resolution["warning"]>;

function warning(code: Warning["code"], over: Partial<Warning> = {}): Warning {
  return { field: `integrations.${GMAIL}`, code, message: "server prose", ...over };
}

/** Nothing binds and nothing refuses: the run starts without Gmail. */
function unbound(over: Partial<Resolution> = {}): Resolution {
  return {
    source: null,
    error_code: null,
    warning: warning("not_connected"),
    resolved_connection_ids: [],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
    org_default_connection_ids: null,
    org_default_enforced: false,
    additional_connections_allowed: false,
    can_add_connection: true,
    candidates: [],
    ...over,
  };
}

function renderCard(
  resolution: Resolution,
  entry: { required?: boolean; blocking?: boolean; active?: boolean; absent?: boolean } = {},
): string {
  const qc = new QueryClient();
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId: GMAIL }, header },
    }).queryKey,
    {
      manifest: { display_name: "Gmail", auths: { oauth: { type: "oauth2" } } },
      auths: [],
      active: entry.active ?? true,
    },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
      params: { path: { scope: "@acme", name: "mailer" }, header },
    }).queryKey,
    {
      blocks_run: entry.blocking ?? false,
      errors: [],
      integrations: entry.absent
        ? []
        : [
            {
              integration_package_id: GMAIL,
              required: entry.required ?? false,
              run_blocking: entry.blocking ?? false,
              inert: false,
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

const label = (key: string, options?: Record<string, string>) =>
  i18n.t(`agents:detail.${key}`, options);
const by = (key: string) => ({ by: i18n.t(`agents:noneChosenBy.${key}`) });

describe("AgentIntegrationsBlock — required", () => {
  it("badges an integration the agent requires, and only that one", () => {
    const blocked = renderCard(
      unbound({ error_code: "required_integration_unbound", warning: null }),
      {
        required: true,
        blocking: true,
      },
    );
    expect(blocked).toContain(`integration-required-${GMAIL}`);
    expect(blocked).toContain(label("integrationRequiredBadge"));
    // A refused run is no unbound state: the picker's warning says it.
    expect(blocked).not.toContain(label("integrationUnbound"));
    expect(renderCard(unbound())).not.toContain(`integration-required-${GMAIL}`);
  });

  it("badges a required integration switched off in the space, too", () => {
    const html = renderCard(unbound(), { active: false, required: true, blocking: true });
    expect(html).toContain(`integration-activate-${GMAIL}`);
    expect(html).toContain(`integration-required-${GMAIL}`);
    expect(renderCard(unbound(), { active: false })).not.toContain(`integration-required-${GMAIL}`);
  });

  it("explains a stored none on a required integration: the launch is blocked, and whose choice", () => {
    const refused = { error_code: "required_integration_unbound" as const, warning: null };
    const required = { required: true, blocking: true };
    const admin = renderCard(unbound({ ...refused, source: "admin_pin" }), required);
    expect(admin).toContain(label("integrationRequiredNoneBy", by("adminPin")));
    // The note under the picker takes the picker's warning tone.
    expect(admin).toContain(`${AMBER_TEXT} mt-1`);
    expect(admin).not.toContain(label("integrationUnboundNoneBy", by("adminPin")));
    expect(admin).toContain(`member-picker-${GMAIL}`);

    const member = renderCard(unbound({ ...refused, source: "member_pin" }), required);
    expect(member).toContain(label("integrationRequiredNoneBy", by("memberPin")));
    expect(member).toContain(`${AMBER_TEXT} mt-1`);
    expect(member).toContain(`member-picker-${GMAIL}`);
  });
});

describe("AgentIntegrationsBlock — why the run starts without it", () => {
  it("nothing usable: not connected", () => {
    const html = renderCard(unbound());
    expect(html).toContain(label("integrationUnbound"));
    expect(html).toContain(`member-picker-${GMAIL}`);
  });

  it("switched off in the space: the activation card, no picker", () => {
    const html = renderCard(unbound({ warning: warning("integration_not_active") }));
    expect(html).toContain(label("integrationUnboundInactive"));
    expect(html).toContain(`integration-activate-${GMAIL}`);
    expect(html).not.toContain(`member-picker-${GMAIL}`);
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("off in the space per its detail: blocking only when the agent requires it", () => {
    const optional = renderCard(unbound({ warning: warning("integration_not_active") }), {
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

  it("a pin to none names whose choice it was, from the warning's source", () => {
    const admin = renderCard(
      unbound({ warning: warning("integration_unbound", { source: "admin_pin" }) }),
    );
    expect(admin).toContain(label("integrationUnboundNoneBy", by("adminPin")));
    expect(admin).not.toContain(label("integrationUnbound"));
    expect(admin).not.toContain(`${AMBER_TEXT} mt-1`);
    expect(
      renderCard(unbound({ warning: warning("integration_unbound", { source: "member_pin" }) })),
    ).toContain(label("integrationUnboundNoneBy", by("memberPin")));
  });

  it("only other members' shared connections: an invitation to pick one", () => {
    const html = renderCard(
      unbound({
        warning: warning("must_choose_connection"),
        candidates: [candidate(false)],
      }),
    );
    expect(html).toContain(label("integrationUnboundSharedOnly"));
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("connections on another auth method: the agent runs without them", () => {
    const html = renderCard(
      unbound({
        warning: warning("auth_key_mismatch", {
          required_auth_key: "oauth",
          available_auth_keys: ["pat"],
        }),
      }),
    );
    expect(html).toContain(label("integrationUnboundOtherAuth"));
    expect(html).not.toContain(label("integrationUnbound"));
  });

  it("says nothing of the kind while a connection binds", () => {
    const html = renderCard(
      unbound({
        source: "fallback_auto",
        warning: null,
        resolved_connection_ids: [candidate(true).id],
        candidates: [candidate(true)],
      }),
    );
    for (const key of [
      "integrationUnbound",
      "integrationUnboundNone",
      "integrationUnboundOtherAuth",
      "integrationUnboundSharedOnly",
      "integrationUnboundInactive",
    ]) {
      expect(html).not.toContain(label(key));
    }
  });
});

describe("AgentIntegrationsBlock — the integration's own detail does not land", () => {
  const detailKey = $api.queryOptions("get", "/api/integrations/{packageId}", {
    params: { path: { packageId: GMAIL }, header },
  }).queryKey;

  /** The detail query in `state`; none seeded is a read the actor may not run (disabled). */
  function renderWith(state: { error: Error } | { fetching: true } | null): string {
    const qc = new QueryClient();
    if (state) {
      const query = qc.getQueryCache().build(qc, { queryKey: detailKey });
      query.setState(
        "error" in state
          ? { ...query.state, status: "error", error: state.error, fetchStatus: "idle" }
          : { ...query.state, fetchStatus: "fetching" },
      );
    }
    return render(
      <AgentIntegrationsBlock
        entries={[{ id: GMAIL, version: "1.0.0", tools: undefined, scopes: undefined }]}
        agentPackageId={AGENT}
      />,
      { queryClient: qc },
    );
  }

  it("holds the cell's place while the detail is being fetched", () => {
    expect(renderWith({ fetching: true })).toContain("animate-pulse");
  });

  it("never waits on a read that does not run: the card shows without a picker", () => {
    const html = renderWith(null);
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain(GMAIL);
    expect(html).not.toContain(`member-picker-${GMAIL}`);
  });

  it("offers the activation when the detail answers 404: not placed in this space", () => {
    const html = renderWith({ error: new ApiError("not_found", "no such integration", 404) });
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain(`integration-activate-${GMAIL}`);
  });

  it("names any other failure, in the warning tone, and claims no inactivity", () => {
    const failure = new ApiError("internal_error", "boom", 500);
    const html = renderWith({ error: failure });
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain(`integration-activate-${GMAIL}`);
    expect(html).toContain(errorMessage(failure));
    expect(html).toContain(`${AMBER_TEXT} text-xs`);
  });
});

describe("AgentIntegrationsBlock — the list", () => {
  it("is one self-contained block per integration, under the list's accessible name", () => {
    const html = renderCard(unbound());
    expect(html).toContain(`aria-label="${label("connectionsTable.label")}"`);
    expect(html).toContain(`data-testid="integration-row-${GMAIL}"`);
    expect(html).toContain(label("connectionsTable.account"));
    expect(html).toContain(label("connectionsTable.unbound"));
    expect(html).not.toContain("<table");
  });

  it("claims no check in progress once the verdict answered without the integration", () => {
    const html = renderCard(unbound(), { absent: true });
    expect(html).not.toContain(`>${label("connectionsTable.checking")}<`);
    expect(html).toContain(">—<");
  });

  it("shows no status on a schedule's blocks", () => {
    const html = renderAs(["integrations:read"], { schedule: true });
    expect(html).toContain(`data-testid="integration-row-${GMAIL}"`);
    expect(html).toContain(label("connectionsTable.account"));
    for (const status of ["inactive", "checking", "required", "unbound", "ready"]) {
      expect(html).not.toContain(`>${label(`connectionsTable.${status}`)}<`);
    }
  });
});

// ─── The admin pin, from the agent's rows ──────────────────────────────────

const ORG = "org_a";
const SPACE = "spc_a";
const scoped = { "X-Org-Id": ORG, "X-Space-Id": SPACE };
const MENU = "Actions pour Gmail";

function adminPin(over: Partial<IntegrationPin> = {}): IntegrationPin {
  return {
    agent_package_id: AGENT,
    integration_package_id: GMAIL,
    connection_ids: [],
    allow_additional_connections: false,
    agent_active: true,
    createdAt: "2026-10-17T10:00:00Z",
    updatedAt: "2026-10-17T10:00:00Z",
    ...over,
  };
}

/** The agent's rows for a caller holding `permissions` in the space, its pins and agents read. */
function renderAs(
  permissions: string[],
  opts: { schedule?: boolean; active?: boolean } = {},
): string {
  const qc = new QueryClient();
  const key = (path: string, params: Record<string, unknown>) =>
    $api.queryOptions("get", path as "/api/integrations/{packageId}", {
      params: params as never,
    }).queryKey;
  qc.setQueryData(key("/api/spaces", { header: { "X-Org-Id": ORG } }), {
    object: "list",
    data: [
      {
        object: "space",
        id: SPACE,
        orgId: ORG,
        name: "Default",
        icon: null,
        color: null,
        isDefault: true,
        settings: {},
        visibility: "open",
        default_role: "viewer",
        personal: false,
        access: "member",
        role: null,
        permissions,
        created_by: null,
        createdAt: "2026-09-05T10:00:00Z",
        updatedAt: "2026-09-05T10:00:00Z",
      },
    ],
    hasMore: false,
  });
  const integration = { path: { packageId: GMAIL }, header: scoped };
  qc.setQueryData(key("/api/integrations/{packageId}", integration), {
    manifest: { display_name: "Gmail", auths: { oauth: { type: "oauth2" } } },
    auths: [],
    active: opts.active ?? true,
  });
  const list = (data: unknown[]) => ({ object: "list", data, hasMore: false });
  qc.setQueryData(key("/api/integrations/{packageId}/pins", integration), list([]));
  qc.setQueryData(key("/api/integrations/{packageId}/connections", integration), list([]));
  qc.setQueryData(
    key("/api/integrations/{packageId}/consuming-agents", integration),
    list([{ agent_package_id: AGENT, display_name: "Mailer" }]),
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE,
  });
  try {
    return render(
      <AgentIntegrationsBlock
        entries={[{ id: GMAIL, version: "1.0.0", tools: undefined, scopes: undefined }]}
        agentPackageId={AGENT}
        {...(opts.schedule && { scheduleOverrides: { value: {}, onChange: () => {} } })}
      />,
      { queryClient: qc },
    );
  } finally {
    org.mockRestore();
    space.mockRestore();
  }
}

describe("AgentIntegrationsBlock — the admin pin in the row's « … »", () => {
  it("is offered to a caller holding integrations:configure, and to nobody else", () => {
    expect(renderAs(["integrations:read", "integrations:configure"])).toContain(
      `aria-label="${MENU}"`,
    );
    const member = renderAs(["integrations:read", "integrations:connect"]);
    expect(member).not.toContain(MENU);
  });

  it("is not offered on an integration that is not active in the space", () => {
    const admin = ["integrations:read", "integrations:configure"];
    // Control: the same caller and row, active, has it.
    expect(renderAs(admin, { active: true })).toContain(MENU);
    expect(renderAs(admin, { active: false })).not.toContain(MENU);
  });

  it("is not offered on a schedule's rows: a pin binds the agent, not the schedule", () => {
    const html = renderAs(["integrations:read", "integrations:configure"], { schedule: true });
    expect(html).not.toContain(MENU);
  });

  const t = (key: string) => i18n.t(`agents:${key}`);
  function actionsFor(
    pin: IntegrationPin | undefined,
    opts: { active?: boolean; loaded?: boolean } = {},
  ) {
    const added: (string | undefined)[] = [];
    const edited: IntegrationPin[] = [];
    const removed: IntegrationPin[] = [];
    const loaded = opts.loaded ?? true;
    const actions = pinRowActions({
      t,
      integrationId: GMAIL,
      agentPackageId: AGENT,
      pin,
      agentActive: opts.active ?? true,
      editor: {
        add: loaded ? (agent) => added.push(agent) : undefined,
        edit: loaded ? (p) => edited.push(p) : undefined,
        remove: (p) => removed.push(p),
      },
    });
    return { actions, added, edited, removed };
  }

  it("imposes connections when the agent has none, on the form fixed to this agent", () => {
    const { actions, added } = actionsFor(undefined);
    expect(actions.map((a) => [a.id, a.label, a.hidden === true])).toEqual([
      ["impose", "Définir des connexions spécifiques", false],
    ]);
    actions[0]!.onSelect!();
    expect(added).toEqual([AGENT]);
  });

  it("offers no « Imposer » for an agent not active in the space, nor before the connections load", () => {
    expect(actionsFor(undefined, { active: false }).actions[0]).toMatchObject({ hidden: true });
    expect(actionsFor(undefined, { loaded: false }).actions[0]).toMatchObject({
      disabled: true,
      onSelect: undefined,
    });
  });

  it("edits or removes a stored pin, removing only through its confirmation", () => {
    const stored = adminPin({ connection_ids: [candidate(true).id] });
    const { actions, edited, removed } = actionsFor(stored);
    expect(actions.map((a) => [a.id, a.label, a.destructive === true])).toEqual([
      ["edit-pin", "Modifier les connexions spécifiques", false],
      ["remove-pin", "Retirer les connexions spécifiques", true],
    ]);
    actions[0]!.onSelect!();
    expect(edited).toEqual([stored]);
    // « Retirer » names the pin to confirm: the editor opens `PinDeleteConfirm`, whose button deletes.
    actions[1]!.onSelect!();
    expect(removed).toEqual([stored]);
    expect(actionsFor(stored, { loaded: false }).actions[0]).toMatchObject({ disabled: true });
  });

  it("opens the integration page's form with this agent chosen and fixed", () => {
    let tree: ReactNode = null;
    function Probe(): null {
      tree = PinFormModal({
        packageId: GMAIL,
        pin: null,
        agents: [{ agent_package_id: AGENT, display_name: "Mailer" }],
        agentId: AGENT,
        connections: [],
        enforcedDefault: false,
        onClose: () => {},
      });
      return null;
    }
    render(<Probe />);
    const fields = findElement(tree, PinFormFields);
    expect(fields?.props).toMatchObject({ agentFixed: true, draft: { agent: AGENT } });
  });
});

/** The first element of `type` in an element tree. */
function findElement<P>(
  node: ReactNode,
  type: (props: P) => ReactNode,
): ReactElement<P> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === type) return node as unknown as ReactElement<P>;
  return findElement(node.props.children, type);
}
