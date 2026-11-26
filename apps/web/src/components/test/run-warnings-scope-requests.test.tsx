// SPDX-License-Identifier: Apache-2.0

/**
 * The scopes a server asked for during a run: named for everyone who sees the run, with the
 * reconnect action only for the viewer who owns the connection (it is in their own account list).
 */

import { describe, expect, it } from "bun:test";
import { installSpaStorage } from "../../test/fake-storage.ts";

installSpaStorage();

const { RunWarnings } = await import("../run-detail/run-warnings.tsx");
const { makeRun } = await import("../../test/run-fixture.ts");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ACTION = "Reconnecter avec ces droits";

function warnings(owned: boolean): string {
  const run = makeRun({
    metadata: {
      scope_requests: [
        {
          integration_id: "@acme/mail",
          connection_id: "conn_1",
          scopes: ["mail.send", "mail.read"],
        },
      ],
    },
  });
  const queryClient = memberSpaceClient([testSpace("spc_a", ["integrations:read"])]);
  queryClient.setQueryData(["get", "/api/me/connections", {}], {
    object: "list",
    hasMore: false,
    data: owned
      ? [
          {
            source_id: "@acme/mail",
            connections: [
              {
                connection_id: "conn_1",
                label: "Travail",
                auth_key: "oauth",
                reconnect_space_id: "spc_a",
                org: { id: "org_1" },
              },
            ],
          },
        ]
      : [],
  });
  return renderInSpace(<RunWarnings run={run} modelFallback={null} />, {
    overview: false,
    queryClient,
  });
}

describe("the run's « Droits supplémentaires demandés » card", () => {
  it("names the scopes, and offers the reconnect to the connection's owner", () => {
    const html = warnings(true);
    expect(html).toContain("Droits supplémentaires demandés pendant ce run");
    expect(html).toContain("mail.send, mail.read");
    expect(html).toContain("Travail");
    expect(html).toContain(ACTION);
  });

  it("offers nothing to a viewer who does not own the connection", () => {
    const html = warnings(false);
    expect(html).toContain("mail.send, mail.read");
    expect(html).not.toContain(ACTION);
  });
});
