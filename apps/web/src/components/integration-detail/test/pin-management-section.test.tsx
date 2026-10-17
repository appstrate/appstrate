// SPDX-License-Identifier: Apache-2.0

/**
 * An admin's per-agent pins of an integration. "Aucune connexion" pins none — so it is offered even
 * when no connection is shared to pin (in the form that opens behind "Ajouter") — and a stored pin
 * to none reads as such. Whether a pin lets runs add connections: a switch per pin in the table,
 * and one in the new-pin form, closed by default. Neither opens over no imposed connection, nor
 * while the space enforces a default for the integration (the server refuses both); a table switch
 * flips neither way while its stored set names an unavailable connection (the rewrite would 404).
 * A member pin never survives under a closed admin pin, so every flip is confirmed by a dialog
 * saying the members' choices go, and the form says it while its switch is off.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { IntegrationPin } from "@appstrate/shared-types";
import type { DataColumn } from "../../data-table.tsx";
import type { MenuItem } from "../../../test/connection-menu-tree.tsx";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const i18nModule = await import("../../../i18n.ts");
const { $api } = await import("../../../api/client.ts");
const { render } = await import("../../../test/render.tsx");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { usePinColumns } = await import("../pin-columns.tsx");
const { AdditionsToggleConfirm, NewPinForm, PinManagementSection } =
  await import("../pin-management-section.tsx");
const { descriptionOf, menuItems } = await import("../../../test/connection-menu-tree.tsx");
const settingsFr = (await import("../../../locales/fr/settings.json")).default;
const settingsEn = (await import("../../../locales/en/settings.json")).default;

const i18n = i18nModule.default;
await i18nModule.i18nReady;
await i18n.changeLanguage("fr");
afterAll(() => i18n.changeLanguage("fr"));

const GMAIL = "@acme/gmail";
const SPACE = "spc_here";
const header = { "X-Org-Id": undefined, "X-Space-Id": SPACE };
const path = { packageId: GMAIL };

const SHARED = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Équipe",
  account_id: "team@acme.test",
  auth_key: "oauth",
  scope: "org" as const,
  spaceId: null,
  shared_here: true,
};

function renderSection(opts: {
  pins?: { agent_package_id: string; connection_ids: string[]; agent_active?: boolean }[];
  connections?: (typeof SHARED)[];
}): string {
  const qc = new QueryClient();
  const keys = {
    pins: $api.queryOptions("get", "/api/integrations/{packageId}/pins", {
      params: { path, header },
    }).queryKey,
    connections: $api.queryOptions("get", "/api/integrations/{packageId}/connections", {
      params: { path, header },
    }).queryKey,
    agents: $api.queryOptions("get", "/api/integrations/{packageId}/consuming-agents", {
      params: { path, header },
    }).queryKey,
  };
  // Fixtures, not wire-complete rows: the section reads only these fields.
  const seed = (key: readonly unknown[], data: unknown[]) =>
    qc.setQueryData(key, { object: "list", data, hasMore: false });
  seed(
    keys.pins,
    (opts.pins ?? []).map((p) => ({
      agent_active: true,
      ...p,
      integration_package_id: GMAIL,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    })),
  );
  seed(keys.connections, opts.connections ?? []);
  seed(keys.agents, [
    { agent_package_id: "@acme/mailer", display_name: "Mailer" },
    { agent_package_id: "@acme/triage", display_name: "Triage" },
  ]);
  // SSR reads Zustand's hydration snapshot: only shared-into-this-space rows are pinnable.
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE,
  });
  try {
    return render(<PinManagementSection packageId={GMAIL} />, { queryClient: qc });
  } finally {
    space.mockRestore();
  }
}

function Form({
  connections,
  onItems,
}: {
  connections: (typeof SHARED)[];
  onItems: (items: Map<string, MenuItem>) => void;
}) {
  const tree: ReactNode = NewPinForm({
    packageId: GMAIL,
    agents: [{ agent_package_id: "@acme/mailer", display_name: "Mailer" }],
    connections: connections as never,
    enforcedDefault: false,
    onDone: () => {},
  });
  onItems(menuItems(tree));
  return null;
}

/** The form behind "Ajouter", with the connections shared into the space: the items of its menu. */
function formItems(connections: (typeof SHARED)[]): Map<string, MenuItem> {
  let items = new Map<string, MenuItem>();
  render(<Form connections={connections} onItems={(found) => (items = found)} />, {
    queryClient: new QueryClient(),
  });
  return items;
}

/** The form rendered closed, as the page shows it. */
function renderForm(connections: (typeof SHARED)[]): string {
  return render(
    <NewPinForm
      packageId={GMAIL}
      agents={[{ agent_package_id: "@acme/mailer", display_name: "Mailer" }]}
      connections={connections as never}
      enforcedDefault={false}
      onDone={() => {}}
    />,
    { queryClient: new QueryClient() },
  );
}

const t = (key: string) => i18n.t(`settings:integration.admin.pinManagement.${key}`);

describe("PinManagementSection, 'Aucune connexion'", () => {
  it("is a mode of the connection menu, beside the shared connections", () => {
    const items = formItems([SHARED]);
    expect(items.get("pin-add-pick-none-connections")).toMatchObject({ value: "none" });
    expect(items.get("pin-add-pick-choose-connections")).toMatchObject({ value: "choose" });
    expect(items.has(`pin-add-pick-option-${SHARED.id}`)).toBe(true);
    // An exception to the default: « Hériter » is the pin's absence, which the table's delete does.
    expect(items.has("pin-add-pick-reset-connections")).toBe(false);
    expect(renderForm([SHARED])).toContain("pin-add-pick-connections");
  });

  it("says both outcomes, since the agent may require the integration", async () => {
    const hint = () =>
      descriptionOf(formItems([SHARED]).get("pin-add-pick-none-connections")?.children);
    expect(hint()).toBe("L'agent s'exécute sans cette intégration, ou ne démarre pas s'il l'exige");
    await i18n.changeLanguage("en");
    try {
      expect(hint()).toBe(
        "The agent runs without this integration, or does not start if it requires it",
      );
    } finally {
      // The i18n instance is shared by the whole process: never leave English behind.
      await i18n.changeLanguage("fr");
    }
  });

  it("is offered even when no connection is shared, which only stops pinning one", () => {
    const items = formItems([]);
    expect(items.has("pin-add-pick-none-connections")).toBe(true);
    const html = renderForm([]);
    expect(html).toContain('data-testid="pin-add-submit"');
    expect(html).toContain(t("noPinnableConnections"));
  });

  it("reads a stored pin to none as 'Aucune connexion'", () => {
    const html = renderSection({
      pins: [{ agent_package_id: "@acme/mailer", connection_ids: [] }],
      connections: [SHARED],
    });
    const row = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*Mailer.*?<\/tr>/s)?.[0] ?? "";
    expect(row).toContain(i18n.t("agents:detail.integrationMemberPicker.none"));
  });
});

const AGENT = "@acme/ops";
const WEB = "11111111-1111-4111-8111-111111111111";

function pin(over: Partial<IntegrationPin> = {}): IntegrationPin {
  return {
    agent_package_id: AGENT,
    integration_package_id: "@acme/drive",
    connection_ids: [WEB],
    allow_additional_connections: false,
    agent_active: true,
    createdAt: "2026-10-17T10:00:00Z",
    updatedAt: "2026-10-17T10:00:00Z",
    ...over,
  };
}

const WEB_CONNECTION = { ...SHARED, id: WEB } as never;

/**
 * The additions cell of a pin, with what its switch hands back when flipped. Only WEB is shared
 * here, once the integration's connections are `loaded`.
 */
function additionsCell(row: IntegrationPin, enforcedDefault: boolean, loaded = true) {
  const connections = loaded ? [WEB_CONNECTION] : undefined;
  let columns: DataColumn<IntegrationPin>[] = [];
  const toggled: IntegrationPin[] = [];
  function Probe({
    onColumns,
  }: {
    onColumns: (found: DataColumn<IntegrationPin>[]) => void;
  }): ReactElement | null {
    const found = usePinColumns({
      agentName: () => "Ops",
      pinnable: connections ?? [],
      connections,
      isDeleting: () => false,
      onDelete: () => {},
      enforcedDefault,
      isToggling: () => false,
      onToggleAdditions: (p) => toggled.push(p),
    });
    onColumns(found);
    return null;
  }
  render(<Probe onColumns={(found) => (columns = found)} />);
  const column = columns.find((c) => c.id === "additions")!;
  const cell = column.cell(row) as ReactElement;
  return { column, html: render(cell), cell, toggled };
}

/** The props of the element carrying `testId`, found in an element tree. */
function propsOf(node: ReactNode, testId: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, testId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.props["data-testid"] === testId) return node.props;
  return propsOf(node.props.children as ReactNode, testId);
}

describe("the pins table's additions column", () => {
  it("is a control column, never waiting for room", () => {
    expect(additionsCell(pin(), false).column).toMatchObject({ control: true });
  });

  it("says the state of each pin, and flips it with the stored pin", () => {
    const closed = additionsCell(pin(), false);
    expect(closed.html).toContain(settingsFr["integration.admin.pinManagement.additionsClosed"]);
    expect(closed.html).not.toContain('disabled=""');
    const props = propsOf(closed.cell, `pin-additions-${AGENT}`)!;
    expect(props.checked).toBe(false);
    (props.onCheckedChange as (checked: boolean) => void)(true);
    expect(closed.toggled).toEqual([pin()]);

    const opened = additionsCell(pin({ allow_additional_connections: true }), false);
    expect(opened.html).toContain(settingsFr["integration.admin.pinManagement.additionsOpen"]);
    expect(propsOf(opened.cell, `pin-additions-${AGENT}`)!.checked).toBe(true);
  });

  it("refuses to open a pin to none, or under an enforced default, and says why", () => {
    const none = additionsCell(pin({ connection_ids: [] }), false);
    expect(none.html).toContain('disabled=""');
    expect(none.html).toContain(
      settingsFr["integration.admin.pinManagement.additionsNeedConnection"],
    );
    const enforced = additionsCell(pin(), true);
    expect(enforced.html).toContain('disabled=""');
    expect(enforced.html).toContain(
      settingsFr["integration.admin.pinManagement.additionsEnforcedDefault"],
    );
  });

  it("always lets an open pin close", () => {
    const html = additionsCell(pin({ allow_additional_connections: true }), true).html;
    expect(html).not.toContain('disabled=""');
  });
});

describe("the pins table's additions switch over an unavailable connection", () => {
  const GONE = "33333333-3333-4333-8333-333333333333";
  const reason = settingsFr["integration.admin.pinManagement.additionsUnavailableConnection"];

  it("flips neither way, and says why", () => {
    for (const allow of [false, true]) {
      const html = additionsCell(
        pin({ connection_ids: [WEB, GONE], allow_additional_connections: allow }),
        false,
      ).html;
      expect(html).toContain('disabled=""');
      expect(html).toContain(reason);
    }
  });

  it("waits, saying nothing, while the connections load", () => {
    const html = additionsCell(pin(), false, false).html;
    expect(html).toContain('disabled=""');
    expect(html).not.toContain(reason);
  });
});

describe("the pins table's additions switch over an agent not active in the space", () => {
  const reason = settingsFr["integration.admin.pinManagement.additionsInactiveAgent"];

  it("flips neither way, and says why", () => {
    for (const allow of [false, true]) {
      const html = additionsCell(
        pin({ allow_additional_connections: allow, agent_active: false }),
        false,
      ).html;
      expect(html).toContain('disabled=""');
      expect(html).toContain(reason);
    }
  });

  it("leaves an active agent's switch alone", () => {
    const html = additionsCell(pin(), false).html;
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(reason);
  });

  it("is read from the pin's own agent_active, which the consuming-agents list does not decide", () => {
    // `@acme/mailer` is in the consuming-agents list, yet the server says the pin's agent is inactive.
    const inactive = renderSection({
      pins: [
        { agent_package_id: "@acme/mailer", connection_ids: [SHARED.id], agent_active: false },
      ],
      connections: [SHARED],
    });
    expect(inactive).toContain(reason);
    // And the reverse: absent from the list, yet active.
    const active = renderSection({
      pins: [{ agent_package_id: "@acme/gone", connection_ids: [SHARED.id], agent_active: true }],
      connections: [SHARED],
    });
    expect(active).not.toContain(reason);
  });
});

describe("the delete confirmation's note", () => {
  it("says, for an open pin, that an enforced space default clears every member's choices", () => {
    const key = "integration.admin.pinManagement.deleteOpenClearsChoices";
    expect(settingsFr[key]).toMatch(/Sous un défaut obligatoire de l’espace, tous les choix/);
    expect(settingsFr[key]).toMatch(/sinon seulement ceux qui ne faisaient que restreindre/);
    expect(settingsEn[key]).toMatch(/Under an enforced space default, all members’ choices/);
    expect(settingsEn[key]).toMatch(/otherwise only those that merely narrowed/);
  });

  it("says, for a closed and an open pin alike, that schedules may be disabled", () => {
    for (const lang of [settingsFr, settingsEn]) {
      for (const key of ["deleteClosedClearsChoices", "deleteOpenClearsChoices"] as const) {
        const sentence = lang[`integration.admin.pinManagement.${key}`];
        expect(sentence).toMatch(/planifications|schedules/);
        expect(sentence.match(/[.!?](\s|$)/g)).toHaveLength(1);
      }
    }
  });
});

/** The confirmation a flip of `row` opens: the props it hands `ConfirmModal`. */
function toggleConfirm(row: IntegrationPin): Record<string, unknown> {
  let props: Record<string, unknown> = {};
  function Probe(): null {
    const element = AdditionsToggleConfirm({
      pin: row,
      agent: "Ops",
      isPending: false,
      onClose: () => {},
      onConfirm: () => {},
    }) as ReactElement<Record<string, unknown>>;
    props = element.props;
    return null;
  }
  render(<Probe />);
  return props;
}

describe("the confirmation of an additions flip", () => {
  const cleared = settingsFr["integration.admin.pinManagement.clearsMemberChoices"];
  const help = settingsFr["integration.admin.pinManagement.allowAdditionsHelp"];

  it("opening: says the members' choices go, and what a run may then combine", () => {
    const props = toggleConfirm(pin());
    expect(props.title).toBe("Autoriser les ajouts pour Ops ?");
    expect(props.confirmLabel).toBe("Autoriser");
    expect(props.description).toBe(cleared);
    expect(render(props.children as ReactElement)).toContain(help);
  });

  it("closing: says the members' choices go, and that schedules adding connections get disabled", () => {
    const props = toggleConfirm(pin({ allow_additional_connections: true }));
    expect(props.title).toBe("Bloquer les ajouts pour Ops ?");
    expect(props.confirmLabel).toBe("Bloquer");
    expect(props.description).toBe(cleared);
    const html = render(props.children as ReactElement);
    expect(html).toContain(settingsFr["integration.admin.pinManagement.closeAdditionsSchedules"]);
    expect(html).not.toContain(help);
  });

  it("opening does not say the schedules' fate", () => {
    const html = render(toggleConfirm(pin()).children as ReactElement);
    expect(html).not.toContain(
      settingsFr["integration.admin.pinManagement.closeAdditionsSchedules"],
    );
  });

  it("says, in both languages, that the schedules fail, are disabled, and stay so", () => {
    const key = "integration.admin.pinManagement.closeAdditionsSchedules";
    expect(settingsFr[key]).toMatch(/échoueront.*désactivées.*ne les réactivera pas/);
    expect(settingsEn[key]).toMatch(/will fail.*be disabled.*will not re-enable/);
  });
});

describe("the new pin's additions switch", () => {
  const form = () =>
    render(
      <NewPinForm
        packageId="@acme/drive"
        agents={[{ agent_package_id: AGENT, display_name: "Ops" }]}
        connections={[]}
        enforcedDefault={false}
        onDone={() => {}}
      />,
    );

  it("starts closed, says what opening means, and waits for an imposed connection", () => {
    const html = form();
    expect(html).toContain('id="pin-add-additions"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(settingsFr["integration.admin.pinManagement.allowAdditions"]);
    expect(html).toContain(settingsFr["integration.admin.pinManagement.allowAdditionsHelp"]);
    expect(html).toContain('data-testid="pin-add-additions-refusal"');
    expect(html).toContain(settingsFr["integration.admin.pinManagement.additionsNeedConnection"]);
  });

  it("says, while it is off, that the members' choices for the agent go", () => {
    const html = form();
    expect(html).toContain('data-testid="pin-add-clears-choices"');
    expect(html).toContain(settingsFr["integration.admin.pinManagement.clearsMemberChoices"]);
  });
});
