// SPDX-License-Identifier: Apache-2.0

/**
 * A tool the run could not serve links to its integration's « Outils » section only when a space's
 * decision settles it (blocked, definition not approved) and the reader can reach that page.
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

const MANAGE = "Gérer les outils";
const INTEGRATION = "@acme/files";

function warnings(reason: string, permissions: string[]): string {
  const run = makeRun({
    metadata: { unavailable_tools: [{ integration_id: INTEGRATION, name: "write", reason }] },
  });
  return renderInSpace(<RunWarnings run={run} modelFallback={null} />, {
    overview: false,
    queryClient: memberSpaceClient([testSpace("spc_a", permissions)]),
  });
}

describe("the unavailable-tools card's « Gérer les outils » link", () => {
  for (const reason of ["blocked_in_space", "definition_not_approved"]) {
    it(`is shown for ${reason} when the integration is reachable`, () => {
      const html = warnings(reason, ["integrations:read"]);
      expect(html).toContain(MANAGE);
      expect(html).toContain("integrationSettings=tools");
    });

    it(`is absent for ${reason} when the integration is not reachable`, () => {
      expect(warnings(reason, [])).not.toContain(MANAGE);
    });
  }

  it("is absent for not_listed, whatever the reader may reach", () => {
    const html = warnings("not_listed", ["integrations:read"]);
    expect(html).toContain("write");
    expect(html).not.toContain(MANAGE);
  });
});
