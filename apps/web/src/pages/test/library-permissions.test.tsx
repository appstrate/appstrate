// SPDX-License-Identifier: Apache-2.0

/**
 * The library's two views, against the placement model they project.
 *
 * A package is placed in a space — homed there, shared there, or system — and
 * the placement carries an instance that is switched on or off. So every
 * control here answers one question with two halves: is this package PLACED in
 * the target space (if not, switching it on is really a share out of its home,
 * and asks for `home_shareable`), and may this caller flip it THERE (the
 * type's grant in that space, or owning it — RBAC spec §3.6).
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { render } from "../../test/render.tsx";
import { LibraryPage, SpacePackagesPage } from "../library-page.tsx";
import type {
  LibraryPackageItem,
  LibraryPlacement,
  LibraryResponse,
} from "../../hooks/use-library.ts";
import i18n, { i18nReady } from "../../i18n.ts";

await i18nReady;
await i18n.changeLanguage("fr");

type Space = components["schemas"]["SpaceObject"];

function space(id: string, permissions: string[], overrides: Partial<Space> = {}): Space {
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
    ...overrides,
  };
}

/** One placement: where the package sits in a space, and whether it runs there. */
function placement(
  space_id: string,
  via: LibraryPlacement["via"],
  state: LibraryPlacement["state"],
  shared_by: LibraryPlacement["shared_by"] = null,
): LibraryPlacement {
  return { space_id, via, state, shared_by };
}

function packageRow(
  type: LibraryPackageItem["type"],
  placements: LibraryPlacement[],
  overrides: Partial<LibraryPackageItem> = {},
): LibraryPackageItem {
  return {
    id: "@org/example",
    name: "Example",
    description: "",
    type,
    source: "local",
    home_space_id: null,
    home_writable: false,
    home_shareable: false,
    placements,
    ...overrides,
  };
}

function libraryOf(spaces: Space[], pkg: LibraryPackageItem): LibraryResponse {
  return {
    object: "library",
    spaces: spaces.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    packages: {
      agent: [],
      skill: [],
      "mcp-server": [],
      integration: [],
      [pkg.type]: [pkg],
    },
  };
}

/**
 * Which explanation a disabled checkbox carries, from the sentence it renders.
 * Each refusal is named apart; an unmapped title comes back verbatim.
 */
function hintOf(element: string): string | null {
  const title = /\stitle="([^"]*)"/.exec(element)?.[1];
  if (title === undefined) return null;
  if (title === i18n.t("library.cannotActivate")) return "activate";
  if (title === i18n.t("library.cannotDeactivate")) return "deactivate";
  if (title === i18n.t("library.cannotShareHere")) return "notPlaced";
  // Not a refusal: a live box on an untaken offer says what taking it up means.
  if (title === i18n.t("library.offerHint")) return "offer";
  return title;
}

function readCheckboxes(html: string) {
  return [...html.matchAll(/<button\b[^>]*role="checkbox"[^>]*>/g)].map(([element]) => ({
    checked: element.includes('aria-checked="true"'),
    disabled: /\sdisabled(?:=|\s|>)/.test(element),
    // `null` when the box is live, and while the permission set is loading.
    hint: hintOf(element),
  }));
}

/** Seed both queries the organization catalog reads, then render it. */
function renderOrgLibrary(spaces: Space[] | undefined, pkg: LibraryPackageItem): string {
  const qc = new QueryClient();
  // Zustand's server snapshot has no selected org; seed that real query key.
  const params = { header: { "X-Org-Id": undefined } };
  qc.setQueryData(
    $api.queryOptions("get", "/api/library", { params }).queryKey,
    libraryOf(spaces ?? [space("spc_a", [])], pkg),
  );
  if (spaces) {
    qc.setQueryData($api.queryOptions("get", "/api/spaces", { params }).queryKey, {
      object: "list",
      data: spaces,
      hasMore: false,
    });
  }
  return render(<LibraryPage />, {
    queryClient: qc,
    initialEntries: [`/library${TAB_HASH[pkg.type]}`],
  });
}

function orgCheckboxes(spaces: Space[] | undefined, pkg: LibraryPackageItem) {
  return readCheckboxes(renderOrgLibrary(spaces, pkg));
}

/** The tab a type's rows live under, so a non-agent case is not rendered blank. */
const TAB_HASH: Record<LibraryPackageItem["type"], string> = {
  agent: "",
  skill: "#skills",
  "mcp-server": "#mcpServers",
  integration: "#integrations",
};

/** Seed the SPACE form — placements already narrowed to the one space. */
function renderSpaceLibrary(target: Space, pkg: LibraryPackageItem): string {
  const qc = new QueryClient();
  const params = { header: { "X-Org-Id": undefined } };
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
      params: { path: { spaceId: "" }, ...params },
    }).queryKey,
    libraryOf([target], pkg),
  );
  qc.setQueryData($api.queryOptions("get", "/api/spaces", { params }).queryKey, {
    object: "list",
    data: [target],
    hasMore: false,
  });
  return render(<SpacePackagesPage />, {
    queryClient: qc,
    initialEntries: [`/space/packages${TAB_HASH[pkg.type]}`],
  });
}

describe("the organization catalog", () => {
  it("names the home space and the spaces the package is shared into", () => {
    const html = renderOrgLibrary(
      [space("spc_home", ["agents:configure"]), space("spc_guest", ["agents:configure"])],
      packageRow(
        "agent",
        [placement("spc_home", "home", "active"), placement("spc_guest", "shared", "none")],
        { home_space_id: "spc_home", home_writable: true, home_shareable: true },
      ),
    );
    // The home is a column of its own, and the share is a chip — the two axes
    // the old single-cell matrix could not tell apart.
    expect(html).toContain(i18n.t("library.column.home"));
    expect(html).toContain(i18n.t("library.column.sharedWith"));
    expect(html).toContain(i18n.t("library.revokeShare"));
  });

  it("offers neither the move nor the share to a caller without the home's authority", () => {
    // CONTROL for the case above, on the same placements: strip
    // `home_writable` / `home_shareable` and both affordances go.
    const html = renderOrgLibrary(
      [space("spc_home", ["agents:configure"]), space("spc_guest", ["agents:configure"])],
      packageRow(
        "agent",
        [placement("spc_home", "home", "active"), placement("spc_guest", "shared", "none")],
        { home_space_id: "spc_home" },
      ),
    );
    expect(html).not.toContain(i18n.t("library.moveHome"));
    expect(html).not.toContain(i18n.t("library.addShare"));
    expect(html).not.toContain(i18n.t("library.revokeShare"));
  });

  it("shows the activation state of each placement, explained as a missing permission", () => {
    expect(
      orgCheckboxes(
        [space("spc_a", []), space("spc_b", [])],
        packageRow("agent", [
          placement("spc_a", "home", "active"),
          placement("spc_b", "shared", "none"),
        ]),
      ),
    ).toEqual([
      { checked: true, disabled: true, hint: "deactivate" },
      { checked: false, disabled: true, hint: "activate" },
    ]);
  });

  it("uses each target space's permission even when no current space is selected", () => {
    expect(
      orgCheckboxes(
        [space("spc_a", []), space("spc_b", ["agents:configure"])],
        packageRow("agent", [
          placement("spc_a", "shared", "inactive"),
          placement("spc_b", "shared", "inactive"),
        ]),
      ),
    ).toEqual([
      { checked: false, disabled: true, hint: "activate" },
      { checked: false, disabled: false, hint: null },
    ]);
  });

  it("lets an admin place a package in a space it never reached, in one click", () => {
    // The Slack-Grid move: no placement in `spc_new` at all, but the caller
    // holds `share` in the home, so the POST shares and activates at once.
    expect(
      orgCheckboxes(
        [space("spc_home", ["agents:configure"]), space("spc_new", ["agents:configure"])],
        packageRow("agent", [placement("spc_home", "home", "active")], {
          home_space_id: "spc_home",
          home_shareable: true,
        }),
      ),
    ).toEqual([
      { checked: true, disabled: false, hint: null },
      { checked: false, disabled: false, hint: null },
    ]);
  });

  it("refuses that click without the home's share grant, and says which half is missing", () => {
    // CONTROL for the case above: same grants in the target space, no
    // `home_shareable` — the box is dead, and not for the reason the
    // permission hint would have given.
    expect(
      orgCheckboxes(
        [space("spc_home", ["agents:configure"]), space("spc_new", ["agents:configure"])],
        packageRow("agent", [placement("spc_home", "home", "active")], {
          home_space_id: "spc_home",
        }),
      ),
    ).toEqual([
      { checked: true, disabled: false, hint: null },
      { checked: false, disabled: true, hint: "notPlaced" },
    ]);
  });

  it("reads activate and deactivate as separate grants for integrations", () => {
    expect(
      orgCheckboxes(
        [
          space("spc_activator", ["integrations:install"]),
          space("spc_remover", ["integrations:uninstall"]),
          space("spc_off", ["integrations:uninstall"]),
          space("spc_new", ["integrations:install"]),
        ],
        packageRow(
          "integration",
          [
            placement("spc_activator", "system", "active"),
            placement("spc_remover", "system", "active"),
            placement("spc_off", "system", "inactive"),
            placement("spc_new", "system", "inactive"),
          ],
          { source: "system" },
        ),
      ),
    ).toEqual([
      // Active, and the caller may only switch ON here.
      { checked: true, disabled: true, hint: "deactivate" },
      { checked: true, disabled: false, hint: null },
      // Off, and the caller may only switch OFF here.
      { checked: false, disabled: true, hint: "activate" },
      { checked: false, disabled: false, hint: null },
    ]);
  });

  it("lets a system agent be switched off in a space, like any other package", () => {
    // "Active here" has ONE definition for the four families — the row wins,
    // and no row means the platform's default. So a system package is not a
    // locked cell: Figma turns off a library it ships, VS Code disables an
    // extension per workspace, and the run gate honours the row it leaves.
    expect(
      orgCheckboxes(
        [space("spc_a", ["agents:configure"])],
        packageRow("agent", [placement("spc_a", "system", "active")], { source: "system" }),
      ),
    ).toEqual([{ checked: true, disabled: false, hint: null }]);
  });

  it("CONTROL: a system agent switched off reads as off, and switches back on", () => {
    // The state comes from the PLACEMENT, not from the source: a materialized
    // `enabled = false` row is the sticky opt-out, and the box mirrors it.
    expect(
      orgCheckboxes(
        [space("spc_a", ["agents:configure"]), space("spc_b", [])],
        packageRow(
          "agent",
          [placement("spc_a", "system", "inactive"), placement("spc_b", "system", "inactive")],
          { source: "system" },
        ),
      ),
    ).toEqual([
      { checked: false, disabled: false, hint: null },
      // And the grant still governs it — being system buys no exemption either way.
      { checked: false, disabled: true, hint: "activate" },
    ]);
  });

  it("does not tell an admin an offer would run on THEIR credentials", () => {
    // CONTROL for the space view's consent sentence: the same untaken offer,
    // with a live box, read from the organization map. The admin switching it
    // on is placing it in somebody ELSE's space, and it is that space's
    // credentials the package would run on — so the sentence R17 puts beside
    // the recipient's switch has no business here.
    const html = renderOrgLibrary(
      [space("spc_guest", ["agents:configure"])],
      packageRow("agent", [
        placement("spc_guest", "shared", "none", { user_id: "usr_1", name: "Alice" }),
      ]),
    );
    expect(readCheckboxes(html)).toEqual([{ checked: false, disabled: false, hint: null }]);
    expect(html).not.toContain(i18n.t("library.offerHint"));
  });

  it("keeps writes disabled while permissions load, blaming nobody for it", () => {
    // Nothing is known about the caller yet, so the box claims no reason.
    expect(
      orgCheckboxes(
        undefined,
        packageRow("integration", [placement("spc_a", "shared", "inactive")]),
      ),
    ).toEqual([{ checked: false, disabled: true, hint: null }]);
  });
});

describe("one space's view", () => {
  it("lists an untaken offer as a placement, with its author and its switch", () => {
    const html = renderSpaceLibrary(
      space("spc_mine", [], { personal: true }),
      packageRow("agent", [
        placement("spc_mine", "shared", "none", { user_id: "usr_1", name: "Alice" }),
      ]),
    );
    expect(html).toContain(i18n.t("library.origin.sharedBy", { name: "Alice" }));
    expect(html).toContain(i18n.t("library.badge.offered"));
    expect(html).toContain(i18n.t("library.spaceHint"));
    // Owning the space IS the authorization (§3.6): no grant anywhere, and the
    // switch is live all the same — carrying, on the box itself, what saying
    // yes means. A header sentence three rows up is not what the reader is
    // looking at when they click (R17).
    expect(readCheckboxes(html)).toEqual([{ checked: false, disabled: false, hint: "offer" }]);
    expect(html).toContain(i18n.t("library.offerHint"));
  });

  it("CONTROL: the same offer in a TEAM space needs the type's grant there", () => {
    const html = renderSpaceLibrary(
      space("spc_team", []),
      packageRow("agent", [
        placement("spc_team", "shared", "none", { user_id: "usr_1", name: "Alice" }),
      ]),
    );
    expect(readCheckboxes(html)).toEqual([{ checked: false, disabled: true, hint: "activate" }]);
  });

  it("marks a placement that was switched off, and keeps it switchable back on", () => {
    const html = renderSpaceLibrary(
      space("spc_team", ["skills:write"]),
      packageRow("skill", [placement("spc_team", "home", "inactive")]),
    );
    expect(html).toContain(i18n.t("library.badge.inactive"));
    expect(html).toContain(i18n.t("library.origin.home"));
    expect(html).not.toContain(i18n.t("library.badge.offered"));
    expect(readCheckboxes(html)).toEqual([{ checked: false, disabled: false, hint: null }]);
  });

  it("names a candidate the caller could place here as exactly that", () => {
    // The route lists a package with NO placement here when this caller could
    // put it here in one click — the organization catalogue they administer, or
    // a package whose home grants them `share`. Calling that "Système" (the
    // other way a row can have no placement) would name the wrong reason.
    const html = renderSpaceLibrary(
      space("spc_team", ["agents:configure"]),
      packageRow("agent", [], { home_shareable: true }),
    );
    expect(html).toContain(i18n.t("library.origin.notPlaced"));
    expect(html).not.toContain(i18n.t("library.origin.system"));
    expect(readCheckboxes(html)).toEqual([{ checked: false, disabled: false, hint: null }]);
  });

  it("CONTROL: an unplaced row the caller cannot share here says which half is missing", () => {
    const html = renderSpaceLibrary(
      space("spc_team", ["agents:configure"]),
      packageRow("agent", []),
    );
    expect(html).toContain(i18n.t("library.origin.notPlaced"));
    expect(readCheckboxes(html)).toEqual([{ checked: false, disabled: true, hint: "notPlaced" }]);
  });

  it("names a share with no author as the space's own, not as somebody's offer", () => {
    // `shared_by: null` is the share a home MOVE leaves behind: the source
    // space keeps reading a package it no longer homes, and nobody offered it.
    const html = renderSpaceLibrary(
      space("spc_team", ["agents:configure"]),
      packageRow("agent", [placement("spc_team", "shared", "active")]),
    );
    expect(html).toContain(i18n.t("library.origin.shared"));
    expect(html).not.toContain("library.origin.sharedBy");
  });
});
