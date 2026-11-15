// SPDX-License-Identifier: Apache-2.0

/** The integration's "how it works" block: a local source names the server it ships and its advisory tool catalog. */

import { describe, expect, it } from "bun:test";
import { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { IntegrationFunctioning } from "../integration-structure.tsx";
import type { IntegrationDetailWire } from "../../../hooks/use-integrations.ts";

await i18nReady;

function renderSource(source: unknown): string {
  const detail = { manifest: { source } } as unknown as IntegrationDetailWire;
  return render(<IntegrationFunctioning detail={detail} />);
}

describe("IntegrationFunctioning, local source", () => {
  it("shows the server type, its entry point and the declared tools", () => {
    const html = renderSource({
      kind: "local",
      server: {
        type: "node",
        entry_point: "server/index.ts",
        mcp_config: { command: "bun" },
        tools: [{ name: "ssh_exec" }, { name: "ssh_upload", description: "Upload" }],
      },
    });
    expect(html).toContain("Serveur local");
    expect(html).toContain("<code>node</code>");
    expect(html).toContain("<code>server/index.ts</code>");
    expect(html).toContain("2 outils");
    expect(html).toContain("ssh_exec, ssh_upload");
  });

  it("says so when the server declares no tool catalog", () => {
    const html = renderSource({
      kind: "local",
      server: { type: "uv", entry_point: "server.py", mcp_config: { command: "uv" } },
    });
    expect(html).toContain("Aucun catalogue déclaré");
  });

  it("links to no server package any more", () => {
    const html = renderSource({
      kind: "local",
      server: { type: "node", entry_point: "a.js", mcp_config: { command: "node" } },
    });
    expect(html).not.toContain("<a ");
  });
});
