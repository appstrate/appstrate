// SPDX-License-Identifier: Apache-2.0

/**
 * The form-level answer to a schedule save that was refused over connections. A connection left
 * to choose is a request, said as information with whose connection and which integration; any
 * other refusal is the destructive list, each integration named by its display name.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import type { ConnectionChoice } from "../../lib/connection-choice.ts";
import { ScheduleConnectionRefusals } from "../schedule-connection-refusals.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const t = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`agents:schedule.connectionOverrides.${key}`, opts);

const CANDIDATE = {
  id: "c_team",
  label: "Équipe",
  account_id: "team@acme.test",
  owned_by_actor: false,
  needs_reconnection: false,
  scopes_granted: [],
  missing_scopes: [],
};

const GMAIL = "@acme/gmail";

/** The detail of an integration, under the key `useIntegrationDetail` reads it by. */
function withNames(names: Record<string, string>): QueryClient {
  const qc = new QueryClient();
  for (const [packageId, display_name] of Object.entries(names)) {
    qc.setQueryData(
      $api.queryOptions("get", "/api/integrations/{packageId}", {
        params: { path: { packageId }, header: { "X-Org-Id": undefined, "X-Space-Id": undefined } },
      }).queryKey,
      { manifest: { display_name } },
    );
  }
  return qc;
}

describe("ScheduleConnectionRefusals", () => {
  it("asks for a choice as information, naming the identity and the integration", () => {
    const html = render(
      <ScheduleConnectionRefusals
        actorName="e2e-C Membre"
        choices={[
          {
            integrationId: GMAIL,
            code: "must_choose_connection",
            candidates: [CANDIDATE, CANDIDATE],
          },
        ]}
      />,
      { queryClient: withNames({ [GMAIL]: "Gmail" }) },
    );
    expect(html).toContain(`schedule-connection-request-${GMAIL}`);
    expect(html).toContain(t("choiceTitle", { integration: "Gmail", actor: "e2e-C Membre" }));
    expect(html).toContain(
      t("choiceBody", { integration: "Gmail", actor: "e2e-C Membre", count: 2 }),
    );
    // A request is not a fault: neither the destructive tone, nor its list.
    expect(html).not.toContain("text-destructive");
    expect(html).not.toContain("schedule-connection-refusals");
    // Said with the display name, never the package id.
    expect(html).not.toContain(`connexion ${GMAIL}`);
  });

  it("falls back to the package id, and to « cette identité », while they are unread", () => {
    const html = render(
      <ScheduleConnectionRefusals
        actorName={null}
        choices={[
          { integrationId: GMAIL, code: "must_choose_connection", candidates: [CANDIDATE] },
        ]}
      />,
      { queryClient: new QueryClient() },
    );
    expect(html).toContain(t("actorFallback"));
    expect(html).toContain(GMAIL);
  });

  it("says when only the identity (or an admin's pin) can choose", () => {
    const html = render(
      <ScheduleConnectionRefusals
        actorName="Alice"
        choices={[{ integrationId: GMAIL, code: "must_choose_connection", candidates: [] }]}
      />,
      { queryClient: withNames({ [GMAIL]: "Gmail" }) },
    );
    expect(html).toContain(t("noCandidateTitle", { integration: "Gmail", actor: "Alice" }));
    expect(html).toContain(t("noCandidateBody", { integration: "Gmail", actor: "Alice" }));
  });

  it("lists every other refusal with its own reason, in the destructive tone", () => {
    const choices: ConnectionChoice[] = [
      { integrationId: "@acme/notion", code: "override_connection_unavailable", candidates: [] },
      { integrationId: "@acme/ssh", code: "auth_serves_no_selected_tool", candidates: [] },
    ];
    const html = render(<ScheduleConnectionRefusals choices={choices} actorName="Alice" />, {
      queryClient: withNames({ "@acme/notion": "Notion" }),
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain(t("refusedTitle"));
    expect(html).toContain("Notion");
    expect(html).toContain("@acme/ssh");
    expect(html).toContain(t("unavailable"));
    expect(html).toContain(i18n.t("agents:error.authServesNoSelectedTool"));
  });

  it("renders nothing once every refusal is answered", () => {
    expect(render(<ScheduleConnectionRefusals choices={[]} actorName={null} />)).toBe("");
  });
});
