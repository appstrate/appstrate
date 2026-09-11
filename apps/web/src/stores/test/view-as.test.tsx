// SPDX-License-Identifier: Apache-2.0

/**
 * The role preview's client half, end to end: what the store persists, what
 * the transport puts on the wire, what entering and leaving do to the cache,
 * when a refusal ends the preview, and what the banner says.
 *
 * The properties worth pinning are the ones a reviewer cannot check by
 * reading: the header grammar has to match the server's parser exactly, the
 * persona must be silent in every organization but its own, the cache reset
 * must spare the one query the org gate blocks on, and the exit path must fire
 * on a refused PERSONA without firing on a denial the persona correctly earned.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
// Type-only: erased at compile time, so it does not pull the store in before
// the fake storage below is installed.
import type { ViewAsPersona } from "../view-as-store.ts";
import { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/client.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

/** Installed before the dynamic imports below: the stores read it at module init. */
const fakeStorage = installFakeStorage();

const {
  viewAsStore,
  enterViewAs,
  exitViewAs,
  getViewAsHeader,
  readPersistedPersona,
  takeViewAsStopped,
  toViewAsPersona,
  STORAGE_KEY,
} = await import("../view-as-store.ts");
const { orgKeys } = await import("../../lib/query-keys.ts");
const { orgStore } = await import("../org-store.ts");
const { spaceStore } = await import("../space-store.ts");
const { queryClient } = await import("../../lib/query-client.ts");
const { $api } = await import("../../api/client.ts");
const { buildScopingHeaders, withViewAsParam } = await import("../../lib/scoping-headers.ts");
const { endPreviewIfRefused, noteViewAsRefusal, viewAsRefusalCode } =
  await import("../../lib/view-as-refusal.ts");
const { ApiError } = await import("../../api/errors.ts");
const { ViewAsBanner } = await import("../../components/view-as-banner.tsx");
const { render } = await import("../../test/render.tsx");
const { i18nReady } = await import("../../i18n.ts");

await i18nReady;

const PERSONA: ViewAsPersona = {
  orgId: "org_a",
  orgRole: "member",
  space: {
    spaceId: "spc_1",
    role: "preset:viewer",
    roleLabel: "Lecteur",
    spaceName: "Marketing",
  },
};

type Organization = components["schemas"]["Organization"];

/** `GET /api/orgs` as the server answers it FOR the persona — its permissions. */
const ORGS_AS_PERSONA: Organization[] = [
  {
    id: "org_a",
    name: "Acme",
    slug: "acme",
    role: "member",
    permissions: ["org:read"],
    createdAt: "2026-01-01T00:00:00Z",
    deleting_at: null,
  },
];

beforeEach(() => {
  fakeStorage.clear();
  viewAsStore.setState({ persona: null, stoppedReason: null });
  orgStore.setState({ id: "org_a" });
  queryClient.removeQueries({ queryKey: orgKeys.all });
});

describe("view-as store", () => {
  it("serializes the header in the grammar the server parses", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(getViewAsHeader()).toBe("org_role=member; space=spc_1; role=preset:viewer");
  });

  it("omits the space pair when the persona names no space", () => {
    enterViewAs({ orgId: "org_a", orgRole: "guest", space: null }, ORGS_AS_PERSONA);
    expect(getViewAsHeader()).toBe("org_role=guest");
  });

  it("stays silent in every organization but its own", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    orgStore.setState({ id: "org_b" });
    expect(getViewAsHeader()).toBeNull();
    expect(buildScopingHeaders()["X-View-As"]).toBeUndefined();
  });

  it("rides on the scoping headers for the previewed organization", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(buildScopingHeaders()).toMatchObject({
      "X-Org-Id": "org_a",
      "X-View-As": "org_role=member; space=spc_1; role=preset:viewer",
    });
  });

  it("persists the persona and drops it on exit", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(JSON.parse(fakeStorage.getItem(STORAGE_KEY)!)).toEqual(PERSONA);
    exitViewAs();
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getViewAsHeader()).toBeNull();
  });
});

describe("hydration", () => {
  it("reads a persisted persona back — this is what a reload resumes from", () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify(PERSONA));
    expect(readPersistedPersona()).toEqual(PERSONA);
  });

  it("drops a stored value that no longer parses rather than sending it", () => {
    // A hand-edited or stale entry would otherwise become a malformed
    // `X-View-As` on every single request.
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ orgId: "org_a", orgRole: "owner" }));
    expect(readPersistedPersona()).toBeNull();
    fakeStorage.setItem(STORAGE_KEY, "{not json");
    expect(readPersistedPersona()).toBeNull();
  });
});

describe("cache reset", () => {
  function spyCache() {
    return {
      remove: spyOn(queryClient, "removeQueries").mockImplementation(() => {}),
      invalidate: spyOn(queryClient, "invalidateQueries").mockImplementation(() =>
        Promise.resolve(),
      ),
    };
  }

  /** The org list is what `OrgGate` blocks on AND what carries the persona's own permissions. */
  function assertOrgListSpared(remove: ReturnType<typeof spyCache>["remove"]) {
    const [{ predicate }] = remove.mock.calls[0] as [
      { predicate: (q: { queryKey: readonly unknown[] }) => boolean },
    ];
    expect(predicate({ queryKey: ["orgs"] })).toBe(false);
    expect(predicate({ queryKey: ["get", "/api/spaces"] })).toBe(true);
  }

  it("empties the scoped cache on entry", () => {
    const { remove, invalidate } = spyCache();
    try {
      enterViewAs(PERSONA, ORGS_AS_PERSONA);
      expect(remove).toHaveBeenCalledTimes(1);
      // The org list is HANDED to the store, so entering never waits on — nor
      // gambles on — a refetch of it.
      expect(invalidate).not.toHaveBeenCalled();
      assertOrgListSpared(remove);
    } finally {
      remove.mockRestore();
      invalidate.mockRestore();
    }
  });

  it("empties it again on exit and re-asks for the caller's own org row", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    const { remove, invalidate } = spyCache();
    try {
      exitViewAs();
      expect(remove).toHaveBeenCalledTimes(1);
      // Invalidated, not just refetched: a refetch that fails would otherwise
      // leave the persona's reduced row serving the caller for good.
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate.mock.calls[0]?.[0]).toEqual({ queryKey: ["orgs"] });
      assertOrgListSpared(remove);
    } finally {
      remove.mockRestore();
      invalidate.mockRestore();
    }
  });

  it("does nothing when there is no preview to leave", () => {
    const { remove, invalidate } = spyCache();
    try {
      exitViewAs();
      expect(remove).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      remove.mockRestore();
      invalidate.mockRestore();
    }
  });

  it("publishes the persona's own org row in the same tick as the persona", () => {
    // #1322: React Query serves the previous value for the whole of a
    // background refetch — and forever if it fails — so committing the persona
    // without its org row leaves `usePermissions` on the previewer's
    // permissions, every org-level admin entry in the menu under a "Lecteur"
    // banner.
    queryClient.setQueryData(orgKeys.all, [
      { ...ORGS_AS_PERSONA[0]!, role: "owner", permissions: ["org:read", "webhooks:read"] },
    ]);
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(queryClient.getQueryData<Organization[]>(orgKeys.all)).toEqual(ORGS_AS_PERSONA);
  });
});

describe("realtime carrier", () => {
  it("appends `view_as` to the stream URL — those routes refuse the header", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(withViewAsParam("/api/realtime/runs?orgId=org_a", getViewAsHeader())).toBe(
      "/api/realtime/runs?orgId=org_a&view_as=org_role%3Dmember%3B%20space%3Dspc_1%3B%20role%3Dpreset%3Aviewer",
    );
  });

  it("uses the value it is handed, so an effect can depend on it", () => {
    // The reactive callers pass `useViewAsHeader()`; a stream reads its URL
    // once, so the value cannot be read from the store inside the builder.
    expect(withViewAsParam("/api/realtime/runs?orgId=org_a", "org_role=guest")).toBe(
      "/api/realtime/runs?orgId=org_a&view_as=org_role%3Dguest",
    );
    expect(withViewAsParam("/api/realtime/runs?orgId=org_a", null)).toBe(
      "/api/realtime/runs?orgId=org_a",
    );
  });
});

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ code, detail: `refused: ${code}` }), { status });
}

const previewedRequest = () => new Headers({ "X-View-As": "org_role=member" });

describe("exit on refusal", () => {
  it("drops the persona and keeps the code when the server refuses it", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    await noteViewAsRefusal(previewedRequest(), refusal(404, "view_as_not_found"));
    expect(viewAsStore.getState().persona).toBeNull();
    // Held for the first mounted frame to say: the refusal lands on the boot
    // org list, before Sonner's `<Toaster/>` can hear a toast.
    expect(viewAsStore.getState().stoppedReason).toBe("view_as_not_found");
  });

  it("keeps the preview on a 404 the previewed role earned", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    await noteViewAsRefusal(previewedRequest(), refusal(404, "not_found"));
    expect(viewAsStore.getState().persona).toEqual(PERSONA);
  });

  it("keeps the preview on an unrelated denial", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    await noteViewAsRefusal(previewedRequest(), refusal(403, "forbidden"));
    expect(viewAsStore.getState().persona).toEqual(PERSONA);
  });

  it("ignores a failure on a request that carried no persona", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    await noteViewAsRefusal(new Headers(), refusal(403, "view_as_forbidden"));
    expect(viewAsStore.getState().persona).toEqual(PERSONA);
  });

  // The SSE routes carry the persona as a QUERY parameter, so their reader
  // takes the header-less door. Its answer is what stops the reconnect loop —
  // a refused preview retried forever is an idle tab hammering a wall.
  it("reports a refused persona to the caller that must stop retrying", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(await endPreviewIfRefused(refusal(403, "view_as_forbidden"))).toBe(true);
    expect(viewAsStore.getState().persona).toBeNull();
  });

  it("reports a transient failure as no refusal, so the caller keeps retrying", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(await endPreviewIfRefused(new Response("gateway down", { status: 502 }))).toBe(false);
    expect(viewAsStore.getState().persona).toEqual(PERSONA);
  });

  it("reports nothing when no preview is running", async () => {
    expect(await endPreviewIfRefused(refusal(403, "view_as_forbidden"))).toBe(false);
  });

  it("ends the preview on every code that means the persona was refused", async () => {
    for (const code of [
      "invalid_view_as",
      "view_as_unsupported",
      "view_as_forbidden",
      "view_as_not_found",
    ]) {
      enterViewAs(PERSONA, ORGS_AS_PERSONA);
      expect(await endPreviewIfRefused(refusal(403, code))).toBe(true);
      expect(viewAsStore.getState().persona).toBeNull();
    }
  });

  it("keeps the preview when the failure carries no code at all", async () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    expect(await endPreviewIfRefused(new Response("{}", { status: 403 }))).toBe(false);
    expect(viewAsStore.getState().persona).toEqual(PERSONA);
  });
});

/**
 * Entering has no response to read — the org listing THROWS — so the dialog
 * names the refusal off the thrown error instead. Three of the four codes are
 * permanent, and "try again" is a lie for all three.
 */
describe("naming a refused entry", () => {
  it("names every code the server refuses the persona with", () => {
    for (const code of [
      "invalid_view_as",
      "view_as_unsupported",
      "view_as_forbidden",
      "view_as_not_found",
    ])
      expect(viewAsRefusalCode(new ApiError(code, "refused", 403))).toBe(code);
  });

  it("names nothing for a denial the persona earned, nor for a transport failure", () => {
    expect(viewAsRefusalCode(new ApiError("forbidden", "denied", 403))).toBeNull();
    expect(viewAsRefusalCode(new TypeError("fetch failed"))).toBeNull();
  });

  it("has copy for every code it names", async () => {
    const { default: i18n } = await import("../../i18n.ts");
    for (const code of ["invalid_view_as", "view_as_forbidden"]) {
      const key = `viewAs.stopped.${viewAsRefusalCode(new ApiError(code, "refused", 403))}`;
      expect(i18n.t(key, { ns: "common" })).not.toBe(key);
    }
  });
});

describe("leaving on purpose", () => {
  it("replaces a running preview rather than stacking a second one", () => {
    // The entry dialog stays reachable under a preview, so submitting again is
    // a replacement — no `exitViewAs()` dance at the call site.
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    enterViewAs(toViewAsPersona("org_a", "guest", undefined, undefined), ORGS_AS_PERSONA);
    expect(viewAsStore.getState().persona).toEqual({
      orgId: "org_a",
      orgRole: "guest",
      space: null,
    });
    expect(getViewAsHeader()).toBe("org_role=guest");
  });

  it("leaves no reason behind when the user simply quits", () => {
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    exitViewAs();
    expect(viewAsStore.getState().stoppedReason).toBeNull();
  });

  it("hands the reason out exactly once", () => {
    // StrictMode runs the effect that shows it twice; the second take must be
    // empty or the user sees the same toast twice.
    enterViewAs(PERSONA, ORGS_AS_PERSONA);
    exitViewAs("view_as_forbidden");
    expect(takeViewAsStopped()).toBe("view_as_forbidden");
    expect(takeViewAsStopped()).toBeNull();
  });
});

type SpaceObject = components["schemas"]["SpaceObject"];

/** A space as `GET /api/spaces` lists it — answered AS the persona once one runs. */
function listedSpace(
  overrides: Partial<SpaceObject> & Pick<SpaceObject, "id" | "name">,
): SpaceObject {
  return {
    object: "space",
    orgId: "org_a",
    isDefault: false,
    settings: {},
    visibility: "open",
    default_role: "operator",
    access: "member",
    role: { kind: "preset", key: "operator", name: "operator" },
    permissions: [],
    created_by: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** SSR reads Zustand's hydration snapshot, not its live state. */
function renderBanner(
  persona: ViewAsPersona | null,
  orgId: string,
  here: { spaceId: string; spaces: SpaceObject[] } = { spaceId: "spc_1", spaces: [] },
): string {
  const viewAsSnapshot = spyOn(viewAsStore, "getInitialState").mockReturnValue({
    ...viewAsStore.getInitialState(),
    persona,
  });
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: orgId,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: here.spaceId,
  });
  const client = new QueryClient();
  client.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": orgId } } }).queryKey,
    { object: "list", data: here.spaces, hasMore: false },
  );
  try {
    return render(<ViewAsBanner />, { queryClient: client });
  } finally {
    viewAsSnapshot.mockRestore();
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("banner", () => {
  it("names the role, the space role and the space, with an exit", () => {
    const html = renderBanner(PERSONA, "org_a");
    expect(html).toContain("Vous voyez l'organisation en tant que");
    expect(html).toContain("Utilisateur standard");
    expect(html).toContain("Lecteur");
    expect(html).toContain("Marketing");
    expect(html).toContain("Quitter");
  });

  it("names only the organization role when the persona has no space", () => {
    const html = renderBanner({ orgId: "org_a", orgRole: "guest", space: null }, "org_a");
    expect(html).toContain("Invité");
    expect(html).not.toContain("Marketing");
  });

  it("names the role the persona holds in another open space, when the user is there", () => {
    const spaces = [
      listedSpace({
        id: "spc_1",
        name: "Marketing",
        role: { kind: "preset", key: "viewer", name: "viewer" },
      }),
      listedSpace({ id: "spc_2", name: "Ventes" }),
    ];
    const elsewhere = renderBanner(PERSONA, "org_a", { spaceId: "spc_2", spaces });
    expect(elsewhere).toContain("Lecteur");
    expect(elsewhere).toContain("Marketing");
    expect(elsewhere).toContain("Ventes");
    expect(elsewhere).toContain("Opérateur");
    expect(elsewhere).toContain("espace ouvert");

    // In the persona's own space the assignment already says it all.
    const home = renderBanner(PERSONA, "org_a", { spaceId: "spc_1", spaces });
    expect(home).not.toContain("espace ouvert");
    expect(home).not.toContain("Opérateur");
  });

  it("says nothing about a space the persona cannot enter", () => {
    const closed = listedSpace({ id: "spc_3", name: "Direction", access: "none", role: null });
    const html = renderBanner(PERSONA, "org_a", { spaceId: "spc_3", spaces: [closed] });
    expect(html).toContain("Lecteur");
    expect(html).not.toContain("Direction");
  });

  // A persona restricts the caller without replacing them, so every capability
  // gated on identity — own runs, own files, own connections — survives the
  // preview. The banner is the one place that boundary is stated.
  it("states that what the previewer created stays visible, whatever the persona", () => {
    const withSpace = renderBanner(PERSONA, "org_a");
    expect(withSpace).toContain("Ce que vous avez créé reste visible");

    const orgOnly = renderBanner({ orgId: "org_a", orgRole: "guest", space: null }, "org_a");
    expect(orgOnly).toContain("Ce que vous avez créé reste visible");
  });

  it("renders nothing outside the previewed organization", () => {
    expect(renderBanner(PERSONA, "org_b")).toBe("");
  });

  it("renders nothing with no persona", () => {
    expect(renderBanner(null, "org_a")).toBe("");
  });
});
