// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components, type paths } from "../../api/client.ts";
import { render } from "../../test/render.tsx";
import { LibraryPage } from "../library-page.tsx";
import i18n, { i18nReady } from "../../i18n.ts";

await i18nReady;
await i18n.changeLanguage("fr");

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

/**
 * Which explanation a disabled checkbox carries, resolved from the bundle
 * sentence it renders.
 *
 * The three reasons are named apart rather than collapsed into "permission":
 * install and uninstall are different sentences chosen by the row's state, so a
 * mapping that answered "permission" to both let the two be swapped silently.
 * An unmapped title comes back verbatim, which fails the comparison loudly.
 */
function hintOf(element: string): string | null {
  const title = /\stitle="([^"]*)"/.exec(element)?.[1];
  if (title === undefined) return null;
  if (title === i18n.t("library.systemAlwaysActive")) return "system";
  if (title === i18n.t("library.cannotInstall")) return "install";
  if (title === i18n.t("library.cannotUninstall")) return "uninstall";
  return title;
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
    // Every disabled box says WHY, and the reasons are different sentences: a
    // system package is always active, a missing permission is the caller's own
    // standing on the operation the row offers. `null` when the box is live and
    // needs no explanation, and while the permission set is still loading.
    hint: hintOf(element),
  }));
}

describe("library installation controls", () => {
  it("shows actual installation state to a viewer, explained as a missing permission", () => {
    expect(
      checkboxes([space("spc_a", []), space("spc_b", [])], packageRow("agent", ["spc_a"])),
    ).toEqual([
      { checked: true, disabled: true, hint: "uninstall" },
      { checked: false, disabled: true, hint: "install" },
    ]);
  });

  it("uses each target space's permission even when no current space is selected", () => {
    expect(
      checkboxes(
        [space("spc_a", []), space("spc_b", ["agents:configure"])],
        packageRow("agent", []),
      ),
    ).toEqual([
      { checked: false, disabled: true, hint: "install" },
      { checked: false, disabled: false, hint: null },
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
      { checked: true, disabled: true, hint: "uninstall" },
      { checked: true, disabled: false, hint: null },
      { checked: false, disabled: true, hint: "install" },
      { checked: false, disabled: false, hint: null },
    ]);
  });

  it("keeps system agents always active and immutable", () => {
    expect(
      checkboxes([space("spc_a", ["agents:configure"])], packageRow("agent", [], "system")),
    ).toEqual([{ checked: true, disabled: true, hint: "system" }]);
  });

  it("keeps writes disabled while permissions load, blaming nobody for it", () => {
    // Nothing is known about the caller yet, so the box says nothing: a
    // loading control that claims a missing permission accuses the operator of
    // something the answer may contradict a moment later.
    expect(checkboxes(undefined, packageRow("integration", []))).toEqual([
      { checked: false, disabled: true, hint: null },
    ]);
  });
});
