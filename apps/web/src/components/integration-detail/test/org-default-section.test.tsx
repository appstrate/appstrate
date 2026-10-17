// SPDX-License-Identifier: Apache-2.0

/**
 * The space default's usage mode: a stored default whose members are all unshared has nothing the
 * server accepts to write a mode change with, so the section says so instead of a draft that
 * reads as saved. An enforced default accepts no addition, so « imposée » is refused, naming the
 * agents, while an admin pin of an active agent (the pin's own `agent_active`) is open to additions
 * (the server answers 409).
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { IntegrationConnection } from "../../../hooks/use-integrations.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { OrgDefaultSection } = await import("../org-default-section.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { render } = await import("../../../test/render.tsx");
const { $api } = await import("../../../api/client.ts");
const i18nModule = await import("../../../i18n.ts");
const settingsFr = (await import("../../../locales/fr/settings.json")).default;
const settingsEn = (await import("../../../locales/en/settings.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";
const INTEGRATION = "@acme/gmail";
const HEADER = { "X-Org-Id": ORG_ID, "X-Space-Id": SPACE_ID };
const SHARED = "11111111-1111-4111-8111-111111111111";
const GONE = "33333333-3333-4333-8333-333333333333";

function connection(id: string): IntegrationConnection {
  return {
    id,
    auth_key: "primary",
    account_id: "root@web",
    label: "web",
    owner_user_id: "usr_me",
    owner_end_user_id: null,
    owner_name: "Moi",
    scopes_granted: [],
    scope: "org",
    spaceId: null,
    shared_here: true,
    shared_space_ids: [SPACE_ID],
    origin_space_id: null,
    needs_reconnection: false,
  } as unknown as IntegrationConnection;
}

function section(
  storedIds: string[],
  pins: {
    agent_package_id: string;
    allow_additional_connections: boolean;
    agent_active?: boolean;
  }[] = [],
  { agentsLoaded = true, enforce = false }: { agentsLoaded?: boolean; enforce?: boolean } = {},
): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    {
      object: "list",
      hasMore: false,
      data: [
        {
          object: "space",
          id: SPACE_ID,
          orgId: ORG_ID,
          name: "Default",
          isDefault: true,
          settings: {},
          visibility: "open",
          default_role: "viewer",
          personal: false,
          access: "member",
          role: null,
          permissions: ["integrations:read", "integrations:configure"],
          created_by: null,
          createdAt: "2026-09-05T10:00:00Z",
          updatedAt: "2026-09-05T10:00:00Z",
        },
      ],
    },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}/default", {
      params: { path: { packageId: INTEGRATION }, header: HEADER },
    }).queryKey,
    { integration_id: INTEGRATION, connection_ids: storedIds, enforce },
  );
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}/connections", {
      params: { path: { packageId: INTEGRATION }, header: HEADER },
    }).queryKey,
    { object: "list", hasMore: false, data: [connection(SHARED)] },
  );
  // Fixtures, not wire-complete rows: the section reads only these fields.
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations/{packageId}/pins", {
      params: { path: { packageId: INTEGRATION }, header: HEADER },
    }).queryKey,
    {
      object: "list",
      hasMore: false,
      data: pins.map((p) => ({
        agent_active: true,
        ...p,
        integration_package_id: INTEGRATION,
        connection_ids: [SHARED],
      })),
    },
  );
  if (agentsLoaded)
    qc.setQueryData(
      $api.queryOptions("get", "/api/integrations/{packageId}/consuming-agents", {
        params: { path: { packageId: INTEGRATION }, header: HEADER },
      }).queryKey,
      {
        object: "list",
        hasMore: false,
        data: [
          { agent_package_id: "@acme/ops", display_name: "Ops" },
          { agent_package_id: "@acme/triage", display_name: "Triage" },
        ],
      },
    );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<OrgDefaultSection packageId={INTEGRATION} />, { queryClient: qc });
  } finally {
    org.mockRestore();
    space.mockRestore();
  }
}

describe("the space default's usage mode", () => {
  it("asks for shared connections before a mode change when every stored one is unshared", () => {
    const html = section([GONE]);
    expect(html).toContain('data-testid="org-default-mode-locked"');
    expect(html).toContain(settingsFr["integration.admin.orgDefault.pickBeforeMode"]);
  });

  it("lets the mode change while a stored connection is still shared", () => {
    expect(section([SHARED, GONE])).not.toContain('data-testid="org-default-mode-locked"');
  });
});

describe("the enforced mode beside admin pins open to additions", () => {
  const locked = 'data-testid="org-default-forced-locked"';

  it("is refused, naming every agent whose pin is open", () => {
    const html = section(
      [SHARED],
      [
        { agent_package_id: "@acme/ops", allow_additional_connections: true },
        { agent_package_id: "@acme/triage", allow_additional_connections: true },
        { agent_package_id: "@acme/closed", allow_additional_connections: false },
      ],
    );
    expect(html).toContain(locked);
    expect(html).toContain("les épinglages de Ops, Triage autorisent les ajouts");
    expect(html).not.toContain("@acme/closed");
  });

  it("ignores the open pin of an agent inactive in the space, as the server does", () => {
    const html = section(
      [SHARED],
      [{ agent_package_id: "@acme/gone", allow_additional_connections: true, agent_active: false }],
    );
    expect(html).not.toContain(locked);
    expect(html).not.toContain("@acme/gone");
  });

  it("counts only the active agents when open pins mix both", () => {
    const html = section(
      [SHARED],
      [
        { agent_package_id: "@acme/ops", allow_additional_connections: true },
        { agent_package_id: "@acme/gone", allow_additional_connections: true, agent_active: false },
      ],
    );
    expect(html).toContain("l’épinglage de Ops autorise les ajouts");
    expect(html).not.toContain("@acme/gone");
  });

  it("needs no consuming-agents list to know the lock, naming the package until it loads", () => {
    const html = section(
      [SHARED],
      [{ agent_package_id: "@acme/ops", allow_additional_connections: true }],
      { agentsLoaded: false },
    );
    expect(html).toContain(locked);
    expect(html).toContain("l’épinglage de @acme/ops autorise les ajouts");
  });

  it("is offered while every pin is closed", () => {
    const html = section(
      [SHARED],
      [{ agent_package_id: "@acme/ops", allow_additional_connections: false }],
    );
    expect(html).not.toContain(locked);
  });
});

describe("the space default's effect on members' own choices", () => {
  const note = 'data-testid="org-default-clears-choices"';

  it("is said beside an enforced default", () => {
    const html = section([SHARED], [], { enforce: true });
    expect(html).toContain(note);
    expect(html).toContain(settingsFr["integration.admin.orgDefault.clearsMemberChoices"]);
  });

  it("says every member's choices go, and schedules only when the default stops being enforced", () => {
    const key = "integration.admin.orgDefault.clearsMemberChoices";
    expect(settingsFr[key]).toMatch(/tous les membres/);
    expect(settingsFr[key]).not.toMatch(/sans épinglage/);
    expect(settingsFr[key]).toMatch(/ne sont désactivées que si .* pas quand son ensemble change/);
    expect(settingsEn[key]).toMatch(/every member/);
    expect(settingsEn[key]).not.toMatch(/without an admin pin/);
    expect(settingsEn[key]).toMatch(/only when .* not when its set changes/);
  });

  it("is not said while the mode is a soft default or a free choice", () => {
    expect(section([SHARED])).not.toContain(note);
    expect(section([])).not.toContain(note);
  });
});
