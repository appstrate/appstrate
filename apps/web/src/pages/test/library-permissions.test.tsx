// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components, type paths } from "../../api/client.ts";
import { render } from "../../test/render.tsx";
import { SpacePackageOffers } from "../../components/package-offers.tsx";
import { LibraryPage, SpacePackagesPage } from "../library-page.tsx";
import i18n, { i18nReady } from "../../i18n.ts";

await i18nReady;
await i18n.changeLanguage("fr");

type Space = components["schemas"]["SpaceObject"];
type Package = components["schemas"]["LibraryPackageList"][number];
type Library = paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];
type SpaceLibrary =
  paths["/api/spaces/{spaceId}/library"]["get"]["responses"][200]["content"]["application/json"];
type Offer = SpaceLibrary["shared"][number];

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
    personal: false,
    access: "member",
    role: null,
    permissions,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

function packageRow(type: Package["type"], installed_in: string[], source = "local"): Package {
  return {
    id: "@org/example",
    name: "Example",
    description: "",
    type,
    source,
    home_space_id: null,
    home_writable: false,
    home_shareable: false,
    installed_in,
  };
}

/**
 * Which explanation a disabled checkbox carries, from the sentence it renders.
 * Install and uninstall are named apart; an unmapped title comes back verbatim.
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
    // `null` when the box is live, and while the permission set is loading.
    hint: hintOf(element),
  }));
}

/**
 * Seed the SPACE library query with one offer and render the space view —
 * where an offer lives. `spaces` seeds both the matrix's column list and
 * `useSpaces`, which is where the per-space grants come from.
 */
function renderSpaceLibraryWithOffer(spaces: Space[], offer: Offer): string {
  const qc = new QueryClient();
  const params = { header: { "X-Org-Id": undefined } };
  const library: SpaceLibrary = {
    object: "library",
    spaces,
    packages: { agent: [], skill: [], "mcp-server": [], integration: [] },
    shared: [offer],
  };
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
      params: { path: { spaceId: "" }, ...params },
    }).queryKey,
    library,
  );
  qc.setQueryData($api.queryOptions("get", "/api/spaces", { params }).queryKey, {
    object: "list",
    data: spaces,
    hasMore: false,
  });
  return render(<SpacePackagesPage />, { queryClient: qc, initialEntries: ["/space/packages"] });
}

/**
 * The labels of the buttons the "Partagé avec moi" section carries.
 */
function offerButtons(spaces: Space[], offer: Offer): string[] {
  const html = renderSpaceLibraryWithOffer(spaces, offer);
  // Bounded at the tab strip that follows the section, so the tab triggers
  // (which are buttons too) do not read as affordances on the offer.
  const start = html.indexOf(i18n.t("library.shared.title"));
  const section = html.slice(start, html.indexOf(i18n.t("library.tab.agents"), start));
  return [...section.matchAll(/<button\b[^>]*>([^<]*)</g)].map(([, label]) => label!.trim());
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "@org/example",
    type: "agent",
    source: "local",
    name: "Example",
    description: "",
    space_id: "spc_team",
    personal: false,
    shared_by: { user_id: "usr_1", name: "Alice" },
    ...overrides,
  };
}

describe("the offers waiting on a decision", () => {
  // A share is READ; the recipient activates it, and there is ONE act behind
  // both buttons — `POST /api/spaces/{spaceId}/packages`. Only who may press
  // differs: owning a personal space is its own authorization, while a TEAM
  // space asks for the type's install grant THERE. Without the button the row
  // named a space and left the reader to hunt the package in the matrix below.
  it("offers the install into a TEAM space to a caller who may install there", () => {
    expect(offerButtons([space("spc_team", ["agents:configure"])], offer())).toEqual([
      i18n.t("library.shared.installIn", { space: "spc_team" }),
    ]);
  });

  it("offers nothing to a caller who reads that space but cannot install there", () => {
    expect(offerButtons([space("spc_team", ["agents:read"])], offer())).toEqual([]);
  });

  it("reads the grant of the OFFERED space, not of some other space", () => {
    expect(
      offerButtons(
        [space("spc_team", ["agents:read"]), space("spc_other", ["agents:configure"])],
        offer(),
      ),
    ).toEqual([]);
  });

  it("offers the install into the caller's own personal space with no grant at all", () => {
    // No install grant anywhere, deliberately: owning the space is the
    // authorization (§3.6), and the row must not read the grant map for it.
    expect(
      offerButtons([space("spc_mine", [])], offer({ space_id: "spc_mine", personal: true })),
    ).toEqual([i18n.t("library.shared.add")]);
  });

  it("names the offer in the SPACE view", () => {
    // The positive half of the control below: the same seed, read where an
    // offer belongs, does show it.
    expect(
      renderSpaceLibraryWithOffer([space("spc_team", ["agents:configure"])], offer()),
    ).toContain(i18n.t("library.shared.title"));
  });

  it("says nothing about offers in the ORGANIZATION catalog", () => {
    // The catalog reads every space at once, so an offer addressed to one of
    // them has no row to belong to — and duplicating it beside the matrix
    // gave the same package two lines and two buttons for one act.
    const qc = new QueryClient();
    const params = { header: { "X-Org-Id": undefined } };
    const spaces = [space("spc_team", ["agents:configure"])];
    // Seeded WITH an offer the schema no longer declares, deliberately: a
    // snapshot without one would pass whatever the page does. The cast is the
    // assertion — the catalog carries no `shared` member, and would render
    // nothing even if a server sent one.
    const library = {
      object: "library",
      spaces,
      packages: { agent: [], skill: [], "mcp-server": [], integration: [] },
      shared: [offer()],
    } as unknown as Library;
    qc.setQueryData($api.queryOptions("get", "/api/library", { params }).queryKey, library);
    qc.setQueryData($api.queryOptions("get", "/api/spaces", { params }).queryKey, {
      object: "list",
      data: spaces,
      hasMore: false,
    });
    const html = render(<LibraryPage />, { queryClient: qc, initialEntries: ["/library"] });
    expect(html).not.toContain(i18n.t("library.shared.title"));
  });
});

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
    // Nothing is known about the caller yet, so the box claims no reason.
    expect(checkboxes(undefined, packageRow("integration", []))).toEqual([
      { checked: false, disabled: true, hint: null },
    ]);
  });
});

describe("pending offers in package lists", () => {
  it.each(["agent", "skill", "mcp-server", "integration"] as const)(
    "shows only current-space %s offers, each with its own install button",
    (type) => {
      const qc = new QueryClient();
      const snapshot: SpaceLibrary = {
        object: "library",
        spaces: [space("spc_mine", [])],
        packages: { agent: [], skill: [], "mcp-server": [], integration: [] },
        shared: [
          offer({ type, personal: true, name: "Pending package", space_id: "spc_mine" }),
          offer({ type: type === "agent" ? "skill" : "agent", name: "Other type" }),
        ],
      };
      qc.setQueryData(
        $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
          params: { path: { spaceId: "" }, header: { "X-Org-Id": undefined } },
        }).queryKey,
        snapshot,
      );
      const html = render(<SpacePackageOffers type={type} />, { queryClient: qc });
      expect(html).toContain("Pending package");
      expect(html).toContain(i18n.t("library.shared.pending"));
      expect(html).toContain(i18n.t("library.shared.add"));
      expect(html).not.toContain("Other type");
    },
  );
});
