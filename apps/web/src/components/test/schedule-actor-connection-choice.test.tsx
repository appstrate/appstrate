// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule that runs as someone else: the viewer's pickers are not shown, and
 * a refused save offers the refusal's own candidates — the actor's connections —
 * as the pick, with a mark only on what is still unanswered.
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

function renderChoice(pendingIds: string[], value: Record<string, string[]>): string {
  return render(
    <ScheduleActorConnectionChoice
      choices={CHOICES}
      pendingIds={pendingIds}
      value={value}
      onChange={() => {}}
    />,
  );
}

describe("ScheduleActorConnectionChoice", () => {
  it("says connections are resolved for the actor, even with nothing refused", () => {
    const html = render(
      <ScheduleActorConnectionChoice choices={[]} pendingIds={[]} value={{}} onChange={() => {}} />,
    );
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.otherActor"));
  });

  it("offers the actor's candidates, flagging a shared one and a dead one", () => {
    const html = renderChoice([GMAIL, NOTION], { [NOTION]: ["gone"] });
    expect(html).toContain("Travail");
    expect(html).toContain("bob@acme.test");
    expect(html).toContain("Équipe");
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.sharedByOther"));
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.needsReconnection"));
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.mustChoose"));
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.unavailable"));
    // No candidates travel with an unreachable pick: the way out is clearing it.
    expect(html).toContain(i18n.t("agents:schedule.connectionOverrides.clearChoice"));
  });

  it("drops the mark once the pick has moved, keeping the row on screen", () => {
    const html = renderChoice([], { [GMAIL]: ["c_work"] });
    expect(html).toContain("Travail");
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.mustChoose"));
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.unavailable"));
    expect(html).not.toContain(i18n.t("agents:schedule.connectionOverrides.clearChoice"));
  });
});
