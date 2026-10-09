// SPDX-License-Identifier: Apache-2.0

/**
 * The run's "Connexions utilisées" card: one row per integration it bound, and
 * one per declared integration it started without — which `connections_used`
 * (one entry per bound connection) cannot carry.
 */

import { describe, expect, it } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import { CONNECTION_RESOLUTION_WARNING_CODES } from "@appstrate/core/integration";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { render } from "../../test/render.tsx";
import { causeSentence } from "../../lib/launch-warnings.ts";

// The agent link reads the app config off `window`.
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });
const { RunConfigurationTab } = await import("../run-configuration-tab.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

function makeRun(overrides: Partial<EnrichedRun>): EnrichedRun {
  return {
    id: "run_1",
    runNumber: 7,
    status: "success",
    packageId: "@acme/reporter",
    started_at: "2026-07-01T10:00:00.000Z",
    version_ref: "1.0.0",
    package_ephemeral: false,
    runOrigin: "platform",
    connections_used: [],
    integrations_unbound: [],
    ...overrides,
  } as unknown as EnrichedRun;
}

const SLACK_UNBOUND = {
  integration_package_id: "@acme/slack",
  code: "not_connected",
  source: null,
} as const;

const GMAIL_USED = {
  integration_package_id: "@acme/gmail",
  label: "Travail",
  account_id: "me@acme.test",
  source: "member_pin",
};

describe("RunConfigurationTab — connections", () => {
  it("lists an integration the run started without, beside the bound ones", () => {
    const html = render(
      <RunConfigurationTab
        run={makeRun({
          connections_used: [GMAIL_USED] as EnrichedRun["connections_used"],
          integrations_unbound: [SLACK_UNBOUND],
        })}
      />,
    );
    expect(html).toContain("Travail");
    expect(html).toContain("run-integration-unbound-@acme/slack");
    expect(html).toContain(i18n.t("agents:run.integrationUnbound"));
    // Control: the bound integration is no unbound row.
    expect(html).not.toContain("run-integration-unbound-@acme/gmail");
  });

  it("shows the card for a run that bound nothing but started without an integration", () => {
    const html = render(
      <RunConfigurationTab run={makeRun({ integrations_unbound: [SLACK_UNBOUND] })} />,
    );
    expect(html).toContain(i18n.t("agents:run.infoConnections"));
    expect(html).toContain("run-integration-unbound-@acme/slack");
  });

  it("says why each integration started without a connection, as the launch toast did", () => {
    for (const code of CONNECTION_RESOLUTION_WARNING_CODES) {
      const html = render(
        <RunConfigurationTab
          run={makeRun({ integrations_unbound: [{ ...SLACK_UNBOUND, code }] })}
        />,
      );
      expect(html).toContain(causeSentence({ code }));
      expect(html).toContain(i18n.t("agents:run.integrationUnbound"));
    }
    const chosen = render(
      <RunConfigurationTab
        run={makeRun({
          integrations_unbound: [
            { ...SLACK_UNBOUND, code: "integration_unbound", source: "schedule_override" },
          ],
        })}
      />,
    );
    expect(chosen).toContain(
      i18n.t("agents:launchWarnings.cause.chosenNoneBy", {
        count: 1,
        by: i18n.t("agents:noneChosenBy.scheduleOverride"),
      }),
    );
  });

  it("shows no card when the run declared nothing to bind", () => {
    const html = render(<RunConfigurationTab run={makeRun({ integrations_unbound: null })} />);
    expect(html).not.toContain(i18n.t("agents:run.infoConnections"));
  });
});
