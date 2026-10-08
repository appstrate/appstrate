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
      },
      {
        id: "c_team",
        label: "Équipe",
        account_id: "team@acme.test",
        owned_by_actor: false,
        needs_reconnection: true,
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

  it("offers the actor's candidates, flagging a shared one and a dead one", () => {
    const html = renderChoice({ [NOTION]: ["gone"] });
    expect(html).toContain("Travail");
    expect(html).toContain("bob@acme.test");
    expect(html).toContain("Équipe");
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.sharedByOther"));
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.needsReconnection"));
    // No candidates travel with an unreachable pick: the way out is clearing it.
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.clearChoice"));
  });

  it("leaves the refusal reasons to the form-level list", () => {
    const html = renderChoice({});
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.mustChoose"));
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.unavailable"));
    expect(html).not.toContain('role="alert"');
  });

  it("lets a picked dead connection be unticked, but not a fresh one ticked", () => {
    const box = (html: string) =>
      html.match(new RegExp(`<button[^>]*id="sched-choice-${GMAIL}-c_team"[^>]*>`))![0];
    expect(box(renderChoice({ [GMAIL]: ["c_team"] }))).not.toContain('disabled=""');
    expect(box(renderChoice({}))).toContain('disabled=""');
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
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.clearChoice"));
  });

  it("with nothing the viewer may name, offers no checkbox", () => {
    const html = render(
      <ScheduleActorConnectionChoice
        choices={[{ integrationId: GMAIL, code: "must_choose_connection", candidates: [] }]}
        integrations={[{ id: GMAIL, required: true }]}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(GMAIL);
    expect(html).not.toContain('role="checkbox"');
  });

  it("offers 'no connection' for each integration the agent does not require, refused or not", () => {
    const html = renderChoice({}, [{ id: GMAIL }, { id: NOTION, required: true }, { id: SLACK }]);
    // Inside the refused card of an optional integration, and on its own row otherwise.
    expect(html).toContain(`id="sched-none-${GMAIL}"`);
    expect(html).toContain(`schedule-actor-none-${SLACK}`);
    expect(html).toContain(`id="sched-none-${SLACK}"`);
    // Control: never for one the agent requires.
    expect(html).not.toContain(`sched-none-${NOTION}`);
  });

  it("shows a stored 'no connection' ticked", () => {
    const box = (html: string) =>
      html.match(new RegExp(`<button[^>]*id="sched-none-${SLACK}"[^>]*>`))![0];
    expect(box(renderChoice({ [SLACK]: [] }, [{ id: SLACK }]))).toContain('aria-checked="true"');
    expect(box(renderChoice({}, [{ id: SLACK }]))).toContain('aria-checked="false"');
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
    expect(html).not.toContain(`sched-none-${GMAIL}`);
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.clearChoice"));
  });
});
