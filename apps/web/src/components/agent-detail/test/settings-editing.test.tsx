// SPDX-License-Identifier: Apache-2.0

/**
 * Paramètres of an agent and of a skill: who may edit the definition in place,
 * and which input schema a pinned version shows.
 *
 * Write authority is the package's HOME space (`home_writable`), never the
 * space being browsed: the harness has no org, so the current space grants
 * nothing, and the editing surfaces must still open for a home writer.
 */

import { afterAll, describe, expect, it } from "bun:test";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import type { Versioned } from "../../../hooks/use-packages.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";

// The file viewers these views reach load the theme store, which reads the
// system theme and tags the root element at module init; the package editor
// they import reaches the auth client, which reads the origin at module init.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});
// Loaded before the stub: it injects its stylesheet when it sees a document.
await import("sonner");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { documentElement: { classList: { add: () => {}, remove: () => {} } } },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { render } = await import("../../../test/render.tsx");
const { AgentSettingsView } = await import("../agent-settings-view.tsx");
const { AgentConfigurationView } = await import("../agent-configuration-view.tsx");
const { PackageSettingsView } = await import("../../package-detail/package-settings-view.tsx");

const AGENT_PATH = "/agents/@acme/worker";
const VERSIONS = { canRestore: false, canDelete: false };

function agent(over: Partial<AgentDetail> = {}): Versioned<AgentDetail> {
  return {
    id: "@acme/worker",
    source: "local",
    dependencies: { skills: [], mcp_servers: [], integrations: [] },
    input: {
      schema: { type: "object", properties: { current_field: { type: "string" } } },
      values: {},
      locked_fields: [],
    },
    running_runs: 0,
    last_run: null,
    prompt: "Do the thing.",
    manifest: { name: "@acme/worker" },
    scope: "@acme",
    version: "1.0.0",
    definition: "draft",
    home_space_id: "spc_home",
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    effective_timeout_seconds: 300,
    active: true,
    etag: null,
    ...over,
  };
}

function skill(over: Partial<OrgPackageItemDetail> = {}): Versioned<OrgPackageItemDetail> {
  return {
    id: "@acme/style",
    source: "local",
    version: "1.0.0",
    name: "Style",
    description: null,
    forked_from: null,
    created_by: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    auto_installed: false,
    home_space_id: "spc_home",
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    definition: "draft",
    content: "# Style",
    agents: [],
    etag: null,
    ...over,
  };
}

/** The rail link to `section`, as rendered. */
function railLink(html: string, param: string, section: string): string | undefined {
  return html.match(new RegExp(`<a[^>]*href="[^"]*${param}=${section}[^"]*"[^>]*>.*?</a>`))?.[0];
}

function renderAgentSettings(detail: Versioned<AgentDetail>) {
  return render(
    <AgentSettingsView
      packageId={detail.id}
      detail={detail}
      isHistorical={false}
      versions={VERSIONS}
    />,
    { initialEntries: [`${AGENT_PATH}?agentSettings=versions#settings`] },
  );
}

describe("agent definition editing", () => {
  it("opens to a home writer the space being browsed grants nothing", () => {
    const link = railLink(
      renderAgentSettings(agent({ home_writable: true })),
      "agentSettings",
      "general",
    );
    expect(link).toBeDefined();
    expect(link).not.toContain("lucide-lock");
  });

  it("is locked for a reader of a package whose home they may not write", () => {
    const link = railLink(renderAgentSettings(agent()), "agentSettings", "general");
    expect(link).toContain("lucide-lock");
  });
});

describe("skill definition editing", () => {
  const renderSkill = (detail: Versioned<OrgPackageItemDetail>) =>
    render(
      <PackageSettingsView
        type="skill"
        packageId={detail.id}
        detail={detail}
        versions={VERSIONS}
      />,
      { initialEntries: ["/skills/@acme/style?packageSettings=versions#settings"] },
    );

  it("offers Identité to a home writer", () => {
    expect(
      railLink(renderSkill(skill({ home_writable: true })), "packageSettings", "general"),
    ).toBeDefined();
  });

  it("does not offer it without write authority in the home", () => {
    expect(railLink(renderSkill(skill()), "packageSettings", "general")).toBeUndefined();
  });
});

describe("a pinned version's inputs", () => {
  it("shows the version's own input schema, not the draft's", () => {
    const html = render(
      <AgentConfigurationView
        packageId="@acme/worker"
        detail={agent()}
        section="inputs"
        isHistorical
        inputWrapperOverride={{
          schema: { type: "object", properties: { archived_field: { type: "string" } } },
        }}
      />,
    );
    expect(html).toContain("archived_field");
    expect(html).not.toContain("current_field");
  });
});

describe("a pinned version's per-space settings", () => {
  // Connections and schedules belong to the space, not to a version: reading a
  // past version shows them as they are.
  for (const section of ["connections", "schedules"] as const) {
    it(`renders ${section} as for the live draft`, () => {
      const view = (isHistorical: boolean) =>
        render(
          <AgentConfigurationView
            packageId="@acme/worker"
            detail={agent()}
            section={section}
            isHistorical={isHistorical}
          />,
        );
      expect(view(true)).toBe(view(false));
    });
  }
});
