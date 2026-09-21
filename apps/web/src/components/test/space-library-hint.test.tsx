// SPDX-License-Identifier: Apache-2.0

/**
 * The "the rest is in the space library" line, against the permission that
 * decides what the library actually holds for its reader.
 *
 * The library is built from the TYPE's own `read` in this space
 * (`readableSpaceIds`, `services/package-library.ts`), so the line that sends a
 * reader there has to ask the same question. Gating it on reachability instead
 * — the org-level `spaces:read` the route merely mounts behind — pointed the one
 * preset that can act on NOTHING in that library at a page that is empty for it
 * by design: `runner` holds `agents:run` and `spaces:read` but no `agents:read`,
 * so `/space/packages` answers 200 with an empty list rather than a 403.
 *
 * `runner` is also what makes the pair below discriminating rather than
 * decorative: the SAME caller holds `integrations:read` and not `agents:read`
 * (`RUNNER_PRESET_PERMISSIONS`, `apps/api/src/lib/permissions.ts`), so one
 * fixture must render the link on one type and nothing on the other. A gate
 * that answers per-caller instead of per-type cannot tell those two apart.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

const SPACE_ID = "spc_target";

/**
 * What a `runner` actually holds on this page: the preset's space-level grants
 * verbatim, plus the org-level `spaces:read` that let them reach the space at
 * all. `can()` answers over the UNION of the two lists, so leaving the org half
 * out would quietly retire the very case this file exists for.
 */
const RUNNER = [
  "spaces:read",
  "agents:run",
  "runs:read",
  "runs:cancel",
  "files:read",
  "persistence:read",
  "integrations:read",
  "integrations:connect",
  "integrations:disconnect",
];

// The stores read `localStorage` at module init, so it exists before the
// dynamic imports below pull them in.
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { SpaceLibraryHint } = await import("../space-library-hint.tsx");
const { spaceStore } = await import("../../stores/space-store.ts");
const { $api } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const i18n = i18nModule.default;

/** One row of `GET /api/spaces`, carrying the caller's grants in this space. */
function spaceFixture(permissions: string[]) {
  return {
    object: "space" as const,
    id: SPACE_ID,
    orgId: "org_a",
    name: "Equipe Commerciale",
    isDefault: false,
    settings: {},
    visibility: "open" as const,
    default_role: "viewer",
    personal: false,
    access: "member" as const,
    role: null,
    permissions,
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

/** Render the hint for `type`, with the caller's standing in the space seeded. */
function hintFor(permissions: string[], type: "agent" | "integration" | "skill"): string {
  const qc = new QueryClient();
  // No org is selected in this harness, so every scoped query is `enabled:
  // false` and serves the cache verbatim — which is what the seed below is.
  const orgHeader = { "X-Org-Id": undefined };

  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: orgHeader } }).queryKey,
    { object: "list", data: [spaceFixture(permissions)], hasMore: false },
  );

  // `renderToStaticMarkup` takes zustand's SERVER snapshot, so the current
  // space is seeded on `getInitialState` — seeding `localStorage` would be too
  // late: the whole suite shares one module registry and the store read it at
  // its first import, in whichever file got there first.
  const snapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<SpaceLibraryHint type={type} />, { queryClient: qc });
  } finally {
    snapshot.mockRestore();
  }
}

/** The library link the hint wraps, when it renders one at all. */
function libraryLink(html: string): string | null {
  return html.match(/<a[^>]*href="\/space\/packages"[^>]*>[^<]*<\/a>/)?.[0] ?? null;
}

describe("SpaceLibraryHint", () => {
  it("says nothing to a runner on the agents index — the library is empty for them", () => {
    expect(hintFor(RUNNER, "agent")).toBe("");
  });

  it("points the SAME runner at the library on the integrations page", () => {
    const html = hintFor(RUNNER, "integration");
    expect(libraryLink(html)).not.toBeNull();
    // The whole sentence, not just the link: the bundle string is what the
    // reader sees, and `Trans` is what assembles it around the anchor.
    expect(html).toContain("Packages de cet espace");
  });

  it("points a reader of the type at the library", () => {
    expect(libraryLink(hintFor(["agents:read"], "agent"))).not.toBeNull();
    expect(libraryLink(hintFor(["skills:read"], "skill"))).not.toBeNull();
  });

  it("does not answer the question the route was mounted behind", () => {
    // `spaces:read` is what reaches `/space/packages`, and it is NOT what fills
    // it. A gate that regressed to reachability renders on this fixture.
    expect(hintFor(["spaces:read"], "agent")).toBe("");
    expect(hintFor(["spaces:read"], "integration")).toBe("");
  });

  it("reads the type's OWN permission, not another type's", () => {
    expect(hintFor(["agents:read"], "integration")).toBe("");
    expect(hintFor(["integrations:read"], "agent")).toBe("");
  });

  it("renders the bundle string rather than the key", () => {
    expect(hintFor(["agents:read"], "agent")).not.toContain("library.indexEmptyHint");
    expect(i18n.language).toBe("fr");
  });
});
