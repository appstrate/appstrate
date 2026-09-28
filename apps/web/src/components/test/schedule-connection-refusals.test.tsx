// SPDX-License-Identifier: Apache-2.0

/**
 * The form-level list of what a schedule save is still refused over: it names
 * every refused integration and why, whether or not a picker row renders for it.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import type { ConnectionChoice } from "../../lib/connection-choice.ts";
import { ScheduleConnectionRefusals } from "../schedule-connection-refusals.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const t = (key: string) => i18n.t(`agents:schedule.connectionOverrides.${key}`);

const CANDIDATE = {
  id: "c_team",
  label: "Équipe",
  account_id: "team@acme.test",
  owned_by_actor: false,
  needs_reconnection: false,
};

describe("ScheduleConnectionRefusals", () => {
  it("names each refused integration with its own reason", () => {
    const choices: ConnectionChoice[] = [
      { integrationId: "@acme/gmail", code: "must_choose_connection", candidates: [CANDIDATE] },
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
      { integrationId: "@acme/ssh", code: "auth_serves_no_selected_tool", candidates: [] },
      { integrationId: "@acme/slack", code: "must_choose_connection", candidates: [] },
    ];
    const html = render(<ScheduleConnectionRefusals choices={choices} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(t("refusedTitle"));
    for (const c of choices) expect(html).toContain(c.integrationId);
    expect(html).toContain(t("mustChoose"));
    expect(html).toContain(t("unavailable"));
    expect(html).toContain(t("unserving"));
    expect(html).toContain(t("actorMustChoose"));
  });

  it("renders nothing once every refusal is answered", () => {
    expect(render(<ScheduleConnectionRefusals choices={[]} />)).not.toContain(
      "schedule-connection-refusals",
    );
  });
});
