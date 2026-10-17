// SPDX-License-Identifier: Apache-2.0

/**
 * An admin's per-agent pins of an integration. The table only reads (Agent, Connexions, Mode in
 * words); its « … » holds « Modifier » and « Supprimer ». « Ajouter » and « Modifier » open one form:
 * Agent (fixed when editing), the shared connections as boxes (none ticked pins « Aucune
 * connexion »), Mode (« Exactement ces connexions » by default, « Ces connexions, plus celles de
 * l’utilisateur » disabled with its reason), then the one sentence saying whom saving affects.
 * A pin is deleted only from its confirmation.
 *
 * The form's fields are rendered without the dialog chrome (a Radix dialog renders nothing without
 * a DOM), its draft and verdict from `lib/admin-pin-payload.ts`, whose payloads are pinned there.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { IntegrationPin } from "@appstrate/shared-types";
import type { DataColumn } from "../../data-table.tsx";
import type { MenuAction } from "../../../lib/menu-action.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const i18nModule = await import("../../../i18n.ts");
const { $api } = await import("../../../api/client.ts");
const { render } = await import("../../../test/render.tsx");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { usePinColumns } = await import("../pin-columns.tsx");
const { PinDeleteConfirm, PinFormFields, PinManagementSection } =
  await import("../pin-management-section.tsx");
const { initialPinDraft, pinDraftVerdict } = await import("../../../lib/admin-pin-payload.ts");
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
const AGENT = "@acme/ops";
const WEB = "11111111-1111-4111-8111-111111111111";
const DB = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

const fr = (key: string) => settingsFr[`integration.admin.pinManagement.${key}` as never] as string;
const EXACT = fr("modeExact");
const PLUS = fr("modePlus");

function connection(id: string, label: string) {
  return {
    id,
    label,
    account_id: `${label}@acme.test`,
    auth_key: "oauth",
    scope: "org" as const,
    spaceId: null,
    shared_here: true,
    owner_name: null,
    variables: null,
  };
}
const WEB_CONNECTION = connection(WEB, "Équipe");
const DB_CONNECTION = connection(DB, "Base");

function pin(over: Partial<IntegrationPin> = {}): IntegrationPin {
  return {
    agent_package_id: AGENT,
    integration_package_id: GMAIL,
    connection_ids: [WEB],
    allow_additional_connections: false,
    agent_active: true,
    createdAt: "2026-10-17T10:00:00Z",
    updatedAt: "2026-10-17T10:00:00Z",
    ...over,
  };
}

function renderSection(opts: { pins?: IntegrationPin[]; connections?: unknown[] }): string {
  const qc = new QueryClient();
  const key = (p: string) =>
    $api.queryOptions("get", p as "/api/integrations/{packageId}/pins", {
      params: { path, header },
    }).queryKey;
  const seed = (p: string, data: unknown[]) =>
    qc.setQueryData(key(p), { object: "list", data, hasMore: false });
  seed("/api/integrations/{packageId}/pins", opts.pins ?? []);
  seed("/api/integrations/{packageId}/connections", opts.connections ?? []);
  seed("/api/integrations/{packageId}/consuming-agents", [
    { agent_package_id: AGENT, display_name: "Ops" },
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

/** The pins table's columns, with the pins its « … » hands back. */
function pinColumns(opts: { loaded?: boolean } = {}) {
  const connections = opts.loaded === false ? undefined : [WEB_CONNECTION as never];
  const edited: IntegrationPin[] = [];
  const deleted: IntegrationPin[] = [];
  let columns: DataColumn<IntegrationPin>[] = [];
  function Probe(): ReactElement | null {
    columns = usePinColumns({
      agentName: () => "Ops",
      pinnable: connections ?? [],
      connections,
      isDeleting: () => false,
      onEdit: connections ? (p) => edited.push(p) : undefined,
      onDelete: (p) => deleted.push(p),
    });
    return null;
  }
  render(<Probe />);
  return { columns, edited, deleted };
}

/** The props of the first element carrying `testId`, found in an element tree. */
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

describe("the pins table", () => {
  it("reads Agent, Connexions and Mode, with no control in its cells", () => {
    const html = renderSection({
      pins: [
        pin({ connection_ids: [WEB, GONE] }),
        pin({ agent_package_id: "@acme/triage", allow_additional_connections: true }),
      ],
      connections: [WEB_CONNECTION],
    });
    for (const head of ["Agent", "Connexions", "Mode"]) expect(html).toContain(`>${head}<`);
    expect(html).toContain(EXACT);
    expect(html).toContain(PLUS);
    // An unavailable member is named as such, in the warning tone.
    expect(html).toContain(
      `<span class="text-warning">${settingsFr["integration.admin.unavailableConnection"]}</span>`,
    );
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('data-testid="pin-mode-');
  });

  it("reads a pin to none as « Aucune connexion »", () => {
    const html = renderSection({ pins: [pin({ connection_ids: [] })], connections: [] });
    expect(html).toContain(fr("noConnection"));
  });

  it("holds « Modifier » then « Supprimer » in each row's menu, and the mode as plain text", () => {
    const { columns, edited, deleted } = pinColumns();
    expect(columns.find((c) => c.id === "mode")?.control).toBeUndefined();
    const actions = (
      columns[columns.length - 1]!.cell(pin()) as ReactElement<{ actions: MenuAction[] }>
    ).props.actions;
    expect(actions.map((a) => [a.id, a.label, a.destructive === true])).toEqual([
      ["edit", "Modifier", false],
      ["delete", "Supprimer", true],
    ]);
    actions[0]!.onSelect!();
    expect(edited).toEqual([pin()]);
    // « Supprimer » only names the pin to confirm: the caller opens the confirmation.
    actions[1]!.onSelect!();
    expect(deleted).toEqual([pin()]);
  });

  it("offers no edit until the connections load", () => {
    const { columns } = pinColumns({ loaded: false });
    const edit = (
      columns[columns.length - 1]!.cell(pin()) as ReactElement<{ actions: MenuAction[] }>
    ).props.actions[0]!;
    expect(edit).toMatchObject({ id: "edit", disabled: true, onSelect: undefined });
  });

  it("offers « Ajouter » while an agent has no pin", () => {
    const html = renderSection({ pins: [pin()], connections: [WEB_CONNECTION] });
    expect(html).toContain('data-testid="pin-add"');
    const full = renderSection({
      pins: [pin(), pin({ agent_package_id: "@acme/triage" })],
      connections: [WEB_CONNECTION],
    });
    expect(full).not.toContain('data-testid="pin-add"');
    expect(full).toContain(fr("noConsumingAgents"));
  });
});

/** The form's fields for `stored` (`null` adds), after `edit` changed the draft. */
function formFields(
  stored: IntegrationPin | null,
  opts: {
    edit?: Partial<ReturnType<typeof initialPinDraft>>;
    enforcedDefault?: boolean;
    connections?: unknown[];
  } = {},
) {
  const connections = (opts.connections ?? [WEB_CONNECTION, DB_CONNECTION]) as never[];
  const draft = { ...initialPinDraft(stored), ...opts.edit };
  const unavailableIds = stored
    ? stored.connection_ids.filter((id) => !connections.some((c: { id: string }) => c.id === id))
    : [];
  const verdict = pinDraftVerdict({
    stored,
    connectionIds: draft.connectionIds,
    chosenMode: draft.chosenMode,
    enforcedDefault: opts.enforcedDefault ?? false,
    unavailableIds,
    agentInactive: stored ? !stored.agent_active : false,
  });
  const patches: unknown[] = [];
  const element = (
    <PinFormFields
      editing={stored !== null}
      agents={[{ agent_package_id: AGENT, display_name: "Ops" }]}
      connections={connections}
      unavailableIds={unavailableIds}
      draft={draft}
      verdict={verdict}
      onChange={(patch) => patches.push(patch)}
    />
  );
  let tree: ReactNode = null;
  function Probe(): null {
    tree = PinFormFields(element.props);
    return null;
  }
  render(<Probe />);
  return { html: render(element), tree, verdict, patches };
}

function optionsOf(props: Record<string, unknown>) {
  return (props.options as { value: string; label: string; disabled?: boolean }[]).map(
    ({ value, label, disabled }) => ({ value, label, disabled: disabled === true }),
  );
}

describe("the pin form, adding", () => {
  it("asks for an agent among those without a pin, every shared connection a box, none ticked", () => {
    const { html, verdict } = formFields(null);
    expect(html).toContain(fr("chooseAgent"));
    expect(html).toContain(`data-testid="pin-form-connection-${WEB}"`);
    expect(html).toContain(`data-testid="pin-form-connection-${DB}"`);
    expect(html).not.toContain('aria-checked="true"');
    // None ticked is a pin to « Aucune connexion », said under the boxes.
    expect(html).toContain(fr("noneChecked"));
    expect(verdict.mode).toBe("exact");
  });

  it("starts on « exact », with « plus » disabled while no connection is ticked, and says why", () => {
    const { html, tree } = formFields(null);
    const mode = propsOf(tree, "pin-form-mode")!;
    expect(mode.value).toBe("exact");
    expect(optionsOf(mode)).toEqual([
      { value: "exact", label: EXACT, disabled: false },
      { value: "plus", label: PLUS, disabled: true },
    ]);
    expect(html).toContain(fr("modeExactHelp"));
    expect(html).toContain(fr("additionsNeedConnection"));
  });

  it("offers « plus » once a connection is ticked, except under an enforced default", () => {
    const ticked = formFields(null, { edit: { connectionIds: [WEB] } });
    expect(optionsOf(propsOf(ticked.tree, "pin-form-mode")!)[1]!.disabled).toBe(false);
    expect(ticked.html).not.toContain('data-testid="pin-form-mode-refusal"');
    const enforced = formFields(null, { edit: { connectionIds: [WEB] }, enforcedDefault: true });
    expect(optionsOf(propsOf(enforced.tree, "pin-form-mode")!)[1]!.disabled).toBe(true);
    expect(enforced.html).toContain(fr("additionsEnforcedDefault"));
  });

  it("says, in « exact », that the members' choices for the agent go, and nothing in « plus »", () => {
    expect(formFields(null).html).toContain(fr("clearsMemberChoices"));
    const plus = formFields(null, { edit: { connectionIds: [WEB], chosenMode: "plus" } });
    expect(plus.html).not.toContain('data-testid="pin-form-consequence"');
  });

  it("sends the ticked set and the mode, the flag always named", () => {
    expect(formFields(null, { edit: { connectionIds: [DB, WEB] } }).verdict.body).toEqual({
      connection_ids: [DB, WEB],
      allow_additional_connections: false,
    });
    expect(
      formFields(null, { edit: { connectionIds: [WEB], chosenMode: "plus" } }).verdict.body,
    ).toEqual({ connection_ids: [WEB], allow_additional_connections: true });
    expect(formFields(null).verdict.body).toEqual({
      connection_ids: [],
      allow_additional_connections: false,
    });
  });
});

describe("the pin form, editing", () => {
  it("shows the pin's agent fixed, its set ticked and its mode", () => {
    const { html, tree } = formFields(pin({ allow_additional_connections: true }));
    expect(propsOf(tree, "pin-form-agent")).toMatchObject({ value: AGENT, disabled: true });
    expect(html).toMatch(
      new RegExp(`aria-checked="true"[^>]*data-testid="pin-form-connection-${WEB}"`),
    );
    expect(propsOf(tree, "pin-form-mode")!.value).toBe("plus");
  });

  it("has nothing to save, and says nothing, until the pin changes", () => {
    const same = formFields(pin());
    expect(same.verdict.savable).toBe(false);
    expect(same.html).not.toContain('data-testid="pin-form-consequence"');
    expect(formFields(pin(), { edit: { connectionIds: [WEB, DB] } }).verdict.savable).toBe(true);
  });

  it("says each consequence of saving by the move it makes", () => {
    const cases: [IntegrationPin, Partial<ReturnType<typeof initialPinDraft>>, string | null][] = [
      [pin(), { connectionIds: [DB] }, fr("clearsMemberChoices")],
      [pin(), { chosenMode: "plus" }, fr("clearsMemberChoices")],
      [
        pin({ allow_additional_connections: true }),
        { chosenMode: "exact" },
        fr("clearsMemberChoicesAndSchedules"),
      ],
      [pin({ allow_additional_connections: true }), { connectionIds: [WEB, DB] }, null],
    ];
    for (const [stored, edit, sentence] of cases) {
      const { html } = formFields(stored, { edit });
      if (sentence) expect(html).toContain(sentence);
      else expect(html).not.toContain('data-testid="pin-form-consequence"');
    }
  });

  it("lists an unavailable member ticked, refuses to save it, and saves once it is unticked", () => {
    const stored = pin({ connection_ids: [WEB, GONE] });
    const broken = formFields(stored);
    expect(broken.html).toMatch(
      new RegExp(`aria-checked="true"[^>]*data-testid="pin-form-connection-${GONE}"`),
    );
    expect(broken.html).toContain(settingsFr["integration.admin.unavailableConnection"]);
    expect(broken.html).toContain(fr("additionsUnavailableConnection"));
    expect(broken.verdict.savable).toBe(false);

    const fixed = formFields(stored, { edit: { connectionIds: [WEB] } });
    // Unticked, it stays listed and cannot be ticked again.
    expect(fixed.html).toMatch(
      new RegExp(
        `aria-checked="false"[^>]*disabled=""[^>]*data-testid="pin-form-connection-${GONE}"`,
      ),
    );
    expect(fixed.verdict).toMatchObject({
      savable: true,
      refusal: null,
      body: { connection_ids: [WEB], allow_additional_connections: false },
    });
  });

  it("refuses to save the pin of an agent not active in the space, and says why", () => {
    const { html, tree, verdict } = formFields(pin({ agent_active: false }), {
      edit: { connectionIds: [WEB, DB] },
    });
    expect(optionsOf(propsOf(tree, "pin-form-mode")!)[1]!.disabled).toBe(true);
    expect(html).toContain(fr("additionsInactiveAgent"));
    expect(verdict.savable).toBe(false);
  });

  it("sends a « plus » pin back to « exact » with its set, even under an enforced default", () => {
    const { verdict } = formFields(pin({ allow_additional_connections: true }), {
      edit: { chosenMode: "exact" },
      enforcedDefault: true,
    });
    expect(verdict).toMatchObject({
      savable: true,
      body: { connection_ids: [WEB], allow_additional_connections: false },
    });
  });
});

describe("the pin form's sentences", () => {
  it("names both modes by their effect, in both languages", () => {
    expect([EXACT, PLUS]).toEqual([
      "Exactement ces connexions",
      "Ces connexions, plus celles de l’utilisateur",
    ]);
    expect([
      settingsEn["integration.admin.pinManagement.modeExact"],
      settingsEn["integration.admin.pinManagement.modePlus"],
    ]).toEqual(["Exactly these connections", "These connections, plus the user’s"]);
  });

  it("says each consequence in one sentence, the schedules ones failing, disabled and kept so", () => {
    const key = "integration.admin.pinManagement.clearsMemberChoicesAndSchedules";
    expect(settingsFr[key]).toMatch(/échoueront.*désactivées, sans réactivation/);
    expect(settingsEn[key]).toMatch(/will fail.*be disabled, without being re-enabled/);
    for (const lang of [settingsFr, settingsEn]) {
      for (const k of ["clearsMemberChoices", "clearsMemberChoicesAndSchedules"]) {
        const sentence = lang[`integration.admin.pinManagement.${k}` as never] as string;
        expect(sentence.match(/[.!?](\s|$)/g)).toHaveLength(1);
      }
    }
  });
});

/** The confirmation of deleting `row`: the props it hands `ConfirmModal`, and its button's deed. */
function deleteConfirm(row: IntegrationPin) {
  const confirmed: string[] = [];
  let props: Record<string, unknown> = {};
  function Probe(): null {
    const element = PinDeleteConfirm({
      pin: row,
      agent: "Ops",
      isPending: false,
      onClose: () => {},
      onConfirm: () => confirmed.push(row.agent_package_id),
    }) as ReactElement<Record<string, unknown>>;
    props = element.props;
    return null;
  }
  render(<Probe />);
  return { props, confirmed };
}

describe("deleting a pin", () => {
  it("is a destructive confirmation that deletes only from its own button", () => {
    const { props, confirmed } = deleteConfirm(pin());
    expect(props).toMatchObject({
      open: true,
      title: fr("delete"),
      description:
        "Ops reviendra à la règle générale de l’intégration : la connexion spécifique sera retirée.",
      confirmLabel: "Supprimer",
    });
    expect(props.variant).toBeUndefined();
    expect(confirmed).toEqual([]);
    (props.onConfirm as () => void)();
    expect(confirmed).toEqual([AGENT]);
  });

  it("says what a closed and an open pin take with them", () => {
    expect(render(deleteConfirm(pin()).props.children as ReactElement)).toContain(
      fr("deleteClosedClearsChoices"),
    );
    expect(
      render(
        deleteConfirm(pin({ allow_additional_connections: true })).props.children as ReactElement,
      ),
    ).toContain(fr("deleteOpenClearsChoices"));
  });

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
