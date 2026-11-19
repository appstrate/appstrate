// SPDX-License-Identifier: Apache-2.0

/**
 * A package page's skeleton in « Tous les espaces » draws the space line when the section the page
 * opens starts with one: the default section is the page's own (`resolveAgentSettingsSection`,
 * `resolveIntegrationSettingsSection`), not a guess.
 */

import { describe, expect, it } from "bun:test";
import { installSpaStorage } from "../../test/fake-storage.ts";

installSpaStorage({ location: { pathname: "/", origin: "http://localhost" } });

const { i18nReady } = await import("../../i18n.ts");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");
const { PackageDetailSkeleton } = await import("../loading-skeletons.tsx");

await i18nReady;

/** `SpaceLineBlocks`' row. */
const SPACE_LINE = "mb-6 flex min-h-8 items-center gap-2";

function skeleton(type: "agent" | "integration", grants: string[], entry: string) {
  const queryClient = memberSpaceClient([testSpace("spc_a", grants), testSpace("spc_b", grants)]);
  return renderInSpace(<PackageDetailSkeleton type={type} />, {
    overview: true,
    queryClient,
    initialEntries: [entry],
  });
}

describe("an agent's settings skeleton in « Tous les espaces »", () => {
  it("draws the line of the model, the section opened for a reader who configures it", () => {
    const html = skeleton("agent", ["agents:read", "agents:configure"], "/agents/@a/b#settings");
    expect(html).toContain(SPACE_LINE);
  });

  it("draws none for a reader who configures it nowhere: the page opens the files", () => {
    const html = skeleton("agent", ["agents:read"], "/agents/@a/b#settings");
    expect(html).not.toContain(SPACE_LINE);
  });

  it("draws the line of a space setting named in the address", () => {
    const html = skeleton("agent", ["agents:read"], "/agents/@a/b?agentSettings=model#settings");
    expect(html).not.toContain(SPACE_LINE);
    const configures = skeleton(
      "agent",
      ["agents:read", "agents:configure"],
      "/agents/@a/b?agentSettings=proxy#settings",
    );
    expect(configures).toContain(SPACE_LINE);
  });
});

describe("an integration's settings skeleton in « Tous les espaces »", () => {
  it("draws the line of the Authentification opened for a reader who configures it", () => {
    const html = skeleton(
      "integration",
      ["integrations:read", "integrations:configure"],
      "/integrations/@a/b#settings",
    );
    expect(html).toContain(SPACE_LINE);
  });

  it("draws none for a reader who configures it nowhere: the page opens the files", () => {
    expect(
      skeleton("integration", ["integrations:read"], "/integrations/@a/b#settings"),
    ).not.toContain(SPACE_LINE);
  });
});
