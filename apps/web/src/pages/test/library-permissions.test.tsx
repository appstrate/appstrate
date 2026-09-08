// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components, type paths } from "../../api/client.ts";
import { render } from "../../test/render.tsx";
import { LibraryPage } from "../library-page.tsx";
import { i18nReady } from "../../i18n.ts";

await i18nReady;

type Space = components["schemas"]["SpaceObject"];
type Package = components["schemas"]["LibraryPackageList"][number];
type Library = paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];

function space(id: string, permissions: string[]): Space {
  return {
    object: "space",
    id,
    orgId: "org_a",
    name: id,
    isDefault: false,
    settings: {},
    visibility: "open",
    default_role: "viewer",
    access: "member",
    role: null,
    permissions,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

function packageRow(type: Package["type"], installed_in: string[], source = "local"): Package {
  return { id: "@org/example", name: "Example", description: "", type, source, installed_in };
}

function checkboxes(spaces: Space[] | undefined, pkg: Package) {
  const qc = new QueryClient();
  // Zustand's server snapshot has no selected org; seed that real query key.
  const params = { header: { "X-Org-Id": undefined } };
  const library: Library = {
    object: "library",
    spaces: spaces ?? [space("spc_a", [])],
    packages: { agent: [], skill: [], "mcp-server": [], integration: [], [pkg.type]: [pkg] },
  };
  qc.setQueryData($api.queryOptions("get", "/api/library", { params }).queryKey, library);
  if (spaces) {
    qc.setQueryData($api.queryOptions("get", "/api/spaces", { params }).queryKey, {
      object: "list",
      data: spaces,
      hasMore: false,
    });
  }
  const html = render(<LibraryPage />, {
    queryClient: qc,
    initialEntries: [`/library${pkg.type === "integration" ? "#integrations" : ""}`],
  });
  return [...html.matchAll(/<button\b[^>]*role="checkbox"[^>]*>/g)].map(([element]) => ({
    checked: element.includes('aria-checked="true"'),
    disabled: /\sdisabled(?:=|\s|>)/.test(element),
    systemHint: element.includes("title="),
  }));
}

describe("library installation controls", () => {
  it("shows actual installation state to a viewer, without a system-package hint", () => {
    expect(
      checkboxes([space("spc_a", []), space("spc_b", [])], packageRow("agent", ["spc_a"])),
    ).toEqual([
      { checked: true, disabled: true, systemHint: false },
      { checked: false, disabled: true, systemHint: false },
    ]);
  });

  it("uses each target space's permission even when no current space is selected", () => {
    expect(
      checkboxes(
        [space("spc_a", []), space("spc_b", ["agents:configure"])],
        packageRow("agent", []),
      ),
    ).toEqual([
      { checked: false, disabled: true, systemHint: false },
      { checked: false, disabled: false, systemHint: false },
    ]);
  });

  it("checks uninstall for installed integrations and install for absent integrations", () => {
    expect(
      checkboxes(
        [
          space("spc_installer", ["integrations:install"]),
          space("spc_remover", ["integrations:uninstall"]),
          space("spc_uninstalled", ["integrations:uninstall"]),
          space("spc_new", ["integrations:install"]),
        ],
        packageRow("integration", ["spc_installer", "spc_remover"], "system"),
      ),
    ).toEqual([
      { checked: true, disabled: true, systemHint: false },
      { checked: true, disabled: false, systemHint: false },
      { checked: false, disabled: true, systemHint: false },
      { checked: false, disabled: false, systemHint: false },
    ]);
  });

  it("keeps system agents always active and immutable", () => {
    expect(
      checkboxes([space("spc_a", ["agents:configure"])], packageRow("agent", [], "system")),
    ).toEqual([{ checked: true, disabled: true, systemHint: true }]);
  });

  it("keeps writes disabled while permissions load without changing the installed state", () => {
    expect(checkboxes(undefined, packageRow("integration", []))).toEqual([
      { checked: false, disabled: true, systemHint: false },
    ]);
  });
});
