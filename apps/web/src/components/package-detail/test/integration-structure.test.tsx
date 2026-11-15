// SPDX-License-Identifier: Apache-2.0

/** The integration's "how it works" block: a local source names the server it ships. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { IntegrationFunctioning } from "../integration-structure.tsx";
import type { IntegrationDetailWire } from "../../../hooks/use-integrations.ts";

await i18nReady;
// The source label reads the app config off `window`.
installFakeStorage({
  __APP_CONFIG__: { features: { localIntegrations: true }, trustedOrigins: [] },
});

function renderSource(source: unknown): string {
  const detail = { manifest: { source } } as unknown as IntegrationDetailWire;
  return render(<IntegrationFunctioning detail={detail} />);
}

describe("IntegrationFunctioning, local source", () => {
  it("shows the server type and its entry point", () => {
    const html = renderSource({
      kind: "local",
      server: {
        type: "node",
        entry_point: "server/index.ts",
        mcp_config: { command: "bun" },
      },
    });
    expect(html).toContain("Serveur local");
    expect(html).toContain("<code>node</code>");
    expect(html).toContain("<code>server/index.ts</code>");
  });
});
