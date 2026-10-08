// SPDX-License-Identifier: Apache-2.0

/**
 * The run's "Connexions utilisées" card: one row per integration it bound, and
 * one per declared integration it started without — which `connections_used`
 * (one entry per bound connection) cannot carry.
 */

import { describe, expect, it } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { render } from "../../test/render.tsx";

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
          integrations_unbound: ["@acme/slack"],
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
      <RunConfigurationTab run={makeRun({ integrations_unbound: ["@acme/slack"] })} />,
    );
    expect(html).toContain(i18n.t("agents:run.infoConnections"));
    expect(html).toContain("run-integration-unbound-@acme/slack");
  });

  it("shows no card when the run declared nothing to bind", () => {
    const html = render(<RunConfigurationTab run={makeRun({ integrations_unbound: null })} />);
    expect(html).not.toContain(i18n.t("agents:run.infoConnections"));
  });
});
