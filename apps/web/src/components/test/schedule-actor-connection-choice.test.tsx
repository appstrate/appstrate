// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule that runs as someone else: the viewer's pickers are not shown, and
 * a refused save offers the refusal's own candidates — the actor's connections —
 * as the pick. Why each was refused is the form-level list's to say, not repeated here.
 * "No connection" names none of the actor's connections, so it is offered for every
 * integration the agent does not require.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import type { ConnectionChoice } from "../../lib/connection-choice.ts";
import { ScheduleActorConnectionChoice } from "../schedule-actor-connection-choice.tsx";
import { menuItems, textsOf, type MenuItem } from "../../test/connection-menu-tree.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const GMAIL = "@acme/gmail";
const NOTION = "@acme/notion";
const SLACK = "@acme/slack";

const CHOICES: ConnectionChoice[] = [
  {
    integrationId: GMAIL,
    code: "must_choose_connection",
    candidates: [
      {
        id: "c_work",
        label: "Travail",
        account_id: "bob@acme.test",
        owned_by_actor: true,
        needs_reconnection: false,
        scopes_granted: [],
        missing_scopes: [],
      },
      {
        id: "c_team",
        label: "Équipe",
        account_id: "team@acme.test",
        owned_by_actor: false,
        needs_reconnection: true,
        scopes_granted: [],
        missing_scopes: [],
      },
    ],
  },
  { integrationId: NOTION, code: "override_connection_unavailable", candidates: [] },
];

/** Both declared and required: nothing beyond the refusals' own controls. */
const REQUIRED = [
  { id: GMAIL, required: true },
  { id: NOTION, required: true },
];

function Choice({
  props,
  onItems,
}: {
  props: Parameters<typeof ScheduleActorConnectionChoice>[0];
  onItems: (items: Map<string, MenuItem>) => void;
}) {
  onItems(menuItems(ScheduleActorConnectionChoice(props)));
  return null;
}

/** The items of every connection menu of the section. */
function itemsOf(
  value: Record<string, string[]>,
  integrations: { id: string; required?: boolean }[] = REQUIRED,
  choices: readonly ConnectionChoice[] = CHOICES,
): Map<string, MenuItem> {
  let items = new Map<string, MenuItem>();
  render(
    <Choice
      props={{ choices, integrations, value, onChange: () => {} }}
      onItems={(found) => (items = found)}
    />,
  );
  return items;
}

function renderChoice(
  value: Record<string, string[]>,
  integrations: { id: string; required?: boolean }[] = REQUIRED,
): string {
  return render(
    <ScheduleActorConnectionChoice
      choices={CHOICES}
      integrations={integrations}
      value={value}
      onChange={() => {}}
    />,
  );
}

describe("ScheduleActorConnectionChoice", () => {
  it("says connections are resolved for the actor, even with nothing refused", () => {
    const html = render(
      <ScheduleActorConnectionChoice
        choices={[]}
        integrations={[]}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.otherActor"));
  });

  it("leaves that sentence out where the form has just named the identity", () => {
    const html = render(
      <ScheduleActorConnectionChoice
        choices={[]}
        integrations={[]}
        value={{}}
        onChange={() => {}}
        showContext={false}
      />,
    );
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.otherActor"));
  });

  it("offers the actor's candidates, flagging a shared one and a dead one", () => {
    const items = itemsOf({ [NOTION]: ["gone"] });
    expect(items.has("sched-choice-pick-option-c_work")).toBe(true);
    expect(items.has("sched-choice-pick-option-c_team")).toBe(true);
    const texts = textsOf(items.get("sched-choice-pick-option-c_work")?.children).join("|");
    expect(texts).toContain("Travail");
    expect(texts).toContain("bob@acme.test");
    const team = textsOf(items.get("sched-choice-pick-option-c_team")?.children).join("|");
    expect(team).toContain(i18n.t("agents:schedule.connectionOverrides.sharedByOther"));
    expect(team).toContain(i18n.t("agents:schedule.connectionOverrides.needsReconnection"));
    // No candidates travel with an unreachable pick: the way out is clearing it.
    expect(renderChoice({ [NOTION]: ["gone"] })).toContain(
      i18n.t("agents:connectionOverrides.clearChoice"),
    );
  });

  it("leaves the refusal reasons to the form-level list", () => {
    const html = renderChoice({});
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.choiceTitle"));
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.unavailable"));
    expect(html).not.toContain('role="alert"');
  });

  it("names each integration by its display name, never by its package id's mono line", () => {
    expect(renderChoice({})).not.toContain("font-mono");
  });

  it("lets a picked dead connection be unticked, but not a fresh one ticked", () => {
    expect(itemsOf({}).get("sched-choice-pick-option-c_team")?.disabled).toBe(true);
    expect(itemsOf({ [GMAIL]: ["c_team"] }).get("sched-choice-pick-option-c_team")?.disabled).toBe(
      false,
    );
  });

  it("shows a stored pick nothing refused, read-only and clearable", () => {
    const html = render(
      <ScheduleActorConnectionChoice
        choices={[]}
        integrations={[]}
        value={{ "@acme/slack": ["c_private"] }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("schedule-actor-stored-@acme/slack");
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.privateConnection"));
    expect(html).not.toContain("c_private");
    expect(html).toContain(i18n.t("agents:connectionOverrides.clearChoice"));
  });

  it("with nothing the viewer may name, offers no connection to tick", () => {
    const items = itemsOf(
      {},
      [{ id: GMAIL, required: true }],
      [{ integrationId: GMAIL, code: "must_choose_connection", candidates: [] }],
    );
    expect([...items.keys()].some((id) => id.startsWith("sched-choice-pick-option-"))).toBe(false);
  });

  it("offers 'no connection' for each integration the agent does not require, refused or not", () => {
    const items = itemsOf({}, [{ id: GMAIL }, { id: NOTION, required: true }, { id: SLACK }]);
    // A mode of the refused menu of an optional integration, and of its own row otherwise.
    expect(items.has(`sched-choice-pick-none-${GMAIL}`)).toBe(true);
    expect(items.has(`sched-choice-pick-none-${SLACK}`)).toBe(true);
    // Control: never for one the agent requires.
    expect(items.has(`sched-choice-pick-none-${NOTION}`)).toBe(false);
  });

  it("offers « Hériter » only where nothing was refused: a refusal says inheriting decides nothing", () => {
    const items = itemsOf({}, [{ id: GMAIL }, { id: SLACK }]);
    expect(items.has(`sched-choice-pick-reset-${SLACK}`)).toBe(true);
    expect(items.has(`sched-choice-pick-reset-${GMAIL}`)).toBe(false);
  });

  it("shows a stored 'no connection' as the chosen mode", () => {
    const none = (value: Record<string, string[]>) =>
      itemsOf(value, [{ id: SLACK }]).get(`sched-choice-pick-none-${SLACK}`);
    expect(none({ [SLACK]: [] })).toMatchObject({ checked: true });
    expect(none({})).toMatchObject({ checked: false });
  });

  it("lets a stored 'no connection' on a required integration be cleared", () => {
    const html = render(
      <ScheduleActorConnectionChoice
        choices={[{ integrationId: GMAIL, code: "required_integration_unbound", candidates: [] }]}
        integrations={[{ id: GMAIL, required: true }]}
        value={{ [GMAIL]: [] }}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain(`sched-choice-pick-none-${GMAIL}`);
    expect(html).toContain(i18n.t("agents:connectionOverrides.clearChoice"));
  });
});
