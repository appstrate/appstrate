// SPDX-License-Identifier: Apache-2.0

/**
 * The answer to a schedule write refused over connections, in the new-schedule form and in every
 * section of a schedule's Paramètres. A refusal no pick explains by itself (`override_outranked`,
 * `required_integration_unbound`) is said beside the picker — until its pick moves. The fired
 * version's `required` flags decide where "No connection" is offered.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import type { ConnectionChoice } from "../../lib/connection-choice.ts";
import { ScheduleConnectionAnswer } from "../schedule-connection-answer.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const GMAIL = "@acme/gmail";
const SLACK = "@acme/slack";

const OUTRANKED: ConnectionChoice[] = [
  { integrationId: GMAIL, code: "override_outranked", candidates: [] },
];

function answer(props: Partial<Parameters<typeof ScheduleConnectionAnswer>[0]> = {}): string {
  return render(
    <ScheduleConnectionAnswer
      choices={OUTRANKED}
      submitted={{ [GMAIL]: ["c_private"] }}
      value={{ [GMAIL]: ["c_private"] }}
      integrations={[{ id: GMAIL, required: true }, { id: SLACK }]}
      actorName="Bob"
      onChange={() => {}}
      {...props}
    />,
  );
}

describe("ScheduleConnectionAnswer", () => {
  it("says why an integration was refused, beside the picker", () => {
    const html = answer();
    expect(html).toContain('data-testid="schedule-connection-refusals"');
    expect(html).toContain(i18n.t("agents:error.overrideOutranked"));
    expect(html).toContain(`schedule-actor-choice-${GMAIL}`);
  });

  it("stops saying it once the pick moves", () => {
    const html = answer({ value: {} });
    expect(html).not.toContain(i18n.t("agents:error.overrideOutranked"));
    expect(html).toContain(`schedule-actor-choice-${GMAIL}`);
  });

  it("offers 'No connection' only for the integrations the fired version does not require", () => {
    const html = answer();
    expect(html).toContain(`schedule-actor-none-${SLACK}`);
    expect(html).not.toContain(`schedule-actor-none-${GMAIL}`);
  });
});
