// SPDX-License-Identifier: Apache-2.0

/**
 * The chat header's access chip — its trigger, which is all this harness can
 * see (`renderToStaticMarkup` has no DOM, and Radix portals the popover body).
 *
 * Two properties are worth pinning here, and both are about NOT lying:
 *
 *  - nothing renders until the permission sets have landed. `can()` answers
 *    `false` for a set still in flight, which is indistinguishable from a
 *    denial — a chip that painted then would tell every user, on every hard
 *    reload, that the assistant may do nothing;
 *  - the label is the standing that actually governs the chat. Sessions are
 *    space-scoped rows (RBAC spec §5), so the SPACE role is the specific
 *    answer and the org role is the fallback for a caller standing in none.
 *
 * The capability verdicts themselves are `chat-access.test.ts` — pure, and
 * asserted there rather than through markup this renderer cannot produce.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";

// The stores read `localStorage` at module init, so it exists before the
// dynamic imports below pull them in.
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { ChatAccessChip, ChatCapabilityList } = await import("./chat-access-chip.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { $api } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const i18n = i18nModule.default;

// `chat` is NOT a boot namespace (`i18n-config.ts`): it loads on demand inside
// the chat route's Suspense boundary. `renderToStaticMarkup` has no such
// boundary, so an unloaded namespace makes `useTranslation` suspend and the
// render throws before any assertion. Loading it here reproduces the state the
// component is actually mounted in.
await i18n.loadNamespaces(["chat", "settings"]);

/**
 * One row of `GET /api/spaces`, in a shape the server actually produces
 * (`apps/api/src/routes/spaces.ts`, `toSpaceDto`): `access` is `"member"`
 * exactly when `role` is non-null. An org member standing in an OPEN space is
 * resolved to its `default_role` (`apps/api/src/lib/space-role.ts`), so a null
 * role only comes back for a CLOSED space the caller has not joined — which
 * the listing does include.
 */
function spaceFixture(role: { kind: "preset" | "custom"; key: string; name: string } | null) {
  return {
    object: "space" as const,
    id: SPACE_ID,
    orgId: ORG_ID,
    name: "Espace",
    isDefault: true,
    settings: {},
    visibility: role ? ("open" as const) : ("closed" as const),
    default_role: "operator",
    personal: false,
    access: role ? ("member" as const) : ("none" as const),
    role,
    permissions: role ? ["agents:run"] : [],
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

/**
 * Render the chip. `seedSpaces: false` leaves `GET /api/spaces` unresolved,
 * which is the loading case — `usePermissions().ready` is false and the chip
 * must render nothing.
 */
function chip(options: {
  seedSpaces: boolean;
  spaceRole?: { kind: "preset" | "custom"; key: string; name: string } | null;
}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  qc.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions: ["agents:run"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  if (options.seedSpaces) {
    qc.setQueryData(
      $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
        .queryKey,
      { object: "list", data: [spaceFixture(options.spaceRole ?? null)], hasMore: false },
    );
  }

  // `renderToStaticMarkup` takes zustand's SERVER snapshot, so the current org
  // and space are seeded on `getInitialState` — `localStorage` would be too
  // late, the stores read it at their first import anywhere in the suite.
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<ChatAccessChip />, { queryClient: qc });
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
  }
}

describe("the chat access chip", () => {
  it("renders nothing while the permission sets are still loading", () => {
    // The flash guard. Without it every hard reload paints "you may do
    // nothing" for as long as `GET /api/spaces` takes.
    expect(chip({ seedSpaces: false })).toBe("");
  });

  it("labels itself with the caller's role in THIS space", () => {
    // Chat sessions are space-scoped rows, so the space role is the standing
    // that governs the conversation.
    const html = chip({
      seedSpaces: true,
      spaceRole: { kind: "preset", key: "operator", name: "operator" },
    });
    expect(html).toContain(i18n.t("settings:roles.preset.operator"));
  });

  it("renders a custom role under the name its author typed, not a slug", () => {
    const html = chip({
      seedSpaces: true,
      spaceRole: { kind: "custom", key: "analyste", name: "Analyste" },
    });
    expect(html).toContain("Analyste");
  });

  it("falls back to the org role when the caller holds no role in the space", () => {
    // A closed space the caller has not joined: no space role to show, but
    // there is still a truthful thing to say about who they are.
    const html = chip({ seedSpaces: true, spaceRole: null });
    expect(html).toContain(i18n.t("settings:orgSettings.roleMember"));
  });

  it("names its trigger with the visible role, not a label that hides it", () => {
    // WCAG 2.5.3 label-in-name: an `aria-label` REPLACES the visible text, so
    // one that omitted the role would leave a voice user unable to reach the
    // button by saying what it shows.
    const role = i18n.t("settings:roles.preset.operator");
    const html = chip({
      seedSpaces: true,
      spaceRole: { kind: "preset", key: "operator", name: "operator" },
    });
    const label = /aria-label="([^"]*)"/.exec(html)?.[1];
    expect(label).toBe(i18n.t("chat:access.triggerLabel", { role }));
    expect(label).toContain(role);
  });
});

describe("the capability list", () => {
  // The popover body is portalled and closed in this harness, so the list is
  // rendered on its own — it is the part whose structure carries the meaning.
  const capabilities = [
    { id: "a", labelKey: "access.capability.runAgents", held: () => true, granted: true },
    { id: "b", labelKey: "access.capability.schedule", held: () => false, granted: false },
  ];

  it("puts each verdict in the SAME item as the capability it judges", () => {
    // A screen reader reads each row as one unit: one `li` per capability,
    // label then verdict, so a verdict can never be announced next to a
    // neighbouring row's label.
    const html = render(<ChatCapabilityList capabilities={capabilities} />);
    const items = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!);
    expect(items).toHaveLength(2);

    const run = i18n.t("chat:access.capability.runAgents");
    const schedule = i18n.t("chat:access.capability.schedule");
    const granted = i18n.t("chat:access.granted");
    const denied = i18n.t("chat:access.denied");

    expect(items[0]).toContain(run);
    expect(items[0]).toContain(granted);
    expect(items[0]).not.toContain(denied);
    expect(items[0]!.indexOf(run)).toBeLessThan(items[0]!.indexOf(granted));

    expect(items[1]).toContain(schedule);
    expect(items[1]).toContain(denied);
    expect(items[1]).not.toContain(granted);
    expect(items[1]!.indexOf(schedule)).toBeLessThan(items[1]!.indexOf(denied));
  });
});
