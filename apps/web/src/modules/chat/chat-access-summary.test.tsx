// SPDX-License-Identifier: Apache-2.0

/**
 * The Info tab's access summary (`renderToStaticMarkup` has no DOM).
 *
 * Two properties are worth pinning here, and both are about NOT lying:
 *
 *  - nothing renders until the permission sets have landed. `can()` answers
 *    `false` for a set still in flight, which is indistinguishable from a
 *    denial — a summary that painted then would tell every user, on every hard
 *    reload, that the assistant may do nothing;
 *  - the verdicts judge the spaces the conversation ACTS in (the origin space
 *    alone once it is limited), not the working space the shell stands in; the label names the working space's role, with the org
 *    role as the fallback for a caller standing in none.
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
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { ChatAccessSummary, ChatCapabilityList } = await import("./chat-access-summary.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
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
    icon: null,
    color: null,
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
 * Render the summary. `seedSpaces: false` leaves `GET /api/spaces` unresolved,
 * which is the loading case — `usePermissions().ready` is false and the summary
 * must hold its box as a skeleton, never a verdict.
 */
function summary(options: {
  seedSpaces: boolean;
  spaceRole?: { kind: "preset" | "custom"; key: string; name: string } | null;
  /** Extra rows of the space listing, beside the working space. */
  otherSpaces?: ReturnType<typeof spaceFixture>[];
  /** The conversation's stored scope (`undefined`: loading); none stored yet by default. */
  conversation?: { spaceId: string | null; restricted: boolean } | null;
  /** « Tous les espaces » chosen (it is on only when two spaces admit a list). */
  overview?: boolean;
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
      {
        object: "list",
        data: [spaceFixture(options.spaceRole ?? null), ...(options.otherSpaces ?? [])],
        hasMore: false,
      },
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
  const chosen = [
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_chat", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: options.overview ? { [`u_chat:${ORG_ID}`]: true } : {},
    }),
  ];
  try {
    return render(
      <ChatAccessSummary conversation={"conversation" in options ? options.conversation : null} />,
      {
        queryClient: qc,
      },
    );
  } finally {
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
    for (const stub of chosen) stub.mockRestore();
  }
}

describe("the chat access summary", () => {
  it("holds its box as a skeleton while the permission sets are still loading", () => {
    // The flash guard. Without it every hard reload paints "you may do
    // nothing" for as long as `GET /api/spaces` takes.
    const html = summary({ seedSpaces: false });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("<ul");
  });

  it("labels itself with the caller's role in THIS space", () => {
    // The working space's role is the specific standing the label names.
    const html = summary({
      seedSpaces: true,
      spaceRole: { kind: "preset", key: "operator", name: "operator" },
    });
    expect(html).toContain(i18n.t("settings:roles.preset.operator"));
  });

  it("renders a custom role under the name its author typed, not a slug", () => {
    const html = summary({
      seedSpaces: true,
      spaceRole: { kind: "custom", key: "analyste", name: "Analyste" },
    });
    expect(html).toContain("Analyste");
  });

  it("falls back to the org role when the caller holds no role in the space", () => {
    // A closed space the caller has not joined: no space role to show, but
    // there is still a truthful thing to say about who they are.
    const html = summary({ seedSpaces: true, spaceRole: null });
    expect(html).toContain(i18n.t("common:switcher.role.member"));
  });

  it("names both standings in the role line, the space one being the specific answer", () => {
    const org = i18n.t("common:switcher.role.member");
    const space = i18n.t("settings:roles.preset.operator");
    const html = summary({
      seedSpaces: true,
      spaceRole: { kind: "preset", key: "operator", name: "operator" },
    });
    expect(html).toContain(i18n.t("chat:access.roleLine", { org, space }));
  });

  it("judges the spaces the chat acts in, not the working space", () => {
    // The working space grants no chat permission; another one does, so the assistant can act.
    const runAgents = i18n.t("chat:access.capability.runAgents");
    const granted = i18n.t("chat:access.granted");
    const acting = {
      ...spaceFixture({ kind: "preset", key: "operator", name: "operator" }),
      id: "spc_b",
      isDefault: false,
      permissions: ["chat:write", "chat:read", "mcp:read", "mcp:invoke", "agents:run", "runs:read"],
    };
    const withActing = summary({ seedSpaces: true, spaceRole: null, otherSpaces: [acting] });
    const without = summary({ seedSpaces: true, spaceRole: null });
    const row = (html: string) =>
      [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)]
        .map((m) => m[1]!)
        .find((li) => li.includes(runAgents))!;
    expect(row(withActing)).toContain(granted);
    expect(row(without)).not.toContain(granted);
  });

  it("judges a limited conversation in its origin space alone", () => {
    // `spc_b` grants running agents; the origin space, where the chat acts too, does not.
    const runAgents = i18n.t("chat:access.capability.runAgents");
    const callApi = i18n.t("chat:access.capability.callApi");
    const granted = i18n.t("chat:access.granted");
    const chatPermissions = ["chat:write", "chat:read", "mcp:read", "mcp:invoke"];
    const origin = {
      ...spaceFixture({ kind: "preset", key: "operator", name: "operator" }),
      id: "spc_origin",
      isDefault: false,
      permissions: chatPermissions,
    };
    const runner = {
      ...origin,
      id: "spc_b",
      permissions: [...chatPermissions, "agents:run", "runs:read"],
    };
    const row = (html: string, label: string) =>
      [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)]
        .map((m) => m[1]!)
        .find((li) => li.includes(label))!;
    const judged = (restricted: boolean) =>
      summary({
        seedSpaces: true,
        spaceRole: null,
        otherSpaces: [origin, runner],
        conversation: { spaceId: "spc_origin", restricted },
      });

    expect(row(judged(false), runAgents)).toContain(granted);
    expect(row(judged(true), runAgents)).not.toContain(granted);
    // The origin space's own grants still hold.
    expect(row(judged(true), callApi)).toContain(granted);
  });

  it("names, in « Tous les espaces », the spaces granting each granted row, and none out of it", () => {
    const chatPermissions = ["chat:write", "chat:read", "mcp:read", "mcp:invoke", "files:read"];
    const studio = {
      ...spaceFixture({ kind: "preset", key: "operator", name: "operator" }),
      id: "spc_studio",
      name: "Studio",
      isDefault: false,
      permissions: [...chatPermissions, "agents:run", "runs:read"],
    };
    const vault = { ...studio, id: "spc_vault", name: "Coffre", permissions: chatPermissions };
    const rows = (overview: boolean) =>
      [
        ...summary({
          seedSpaces: true,
          spaceRole: null,
          otherSpaces: [studio, vault],
          overview,
        }).matchAll(/<li[^>]*>(.*?)<\/li>/g),
      ].map((m) => m[1]!);
    const row = (items: string[], key: string) =>
      items.find((li) => li.includes(i18n.t(`chat:access.capability.${key}`)))!;

    const across = rows(true);
    // One space grants running agents, both browse files: the stack's tooltip names them.
    expect(row(across, "runAgents")).toContain('data-testid="space-tile-stack"');
    expect(row(across, "runAgents")).toContain('aria-label="Studio"');
    expect(row(across, "browseFiles")).toContain('aria-label="Studio, Coffre"');
    // A row no acting space grants reads refused, with no tiles.
    expect(row(across, "schedule")).not.toContain("space-tile-stack");
    expect(row(across, "schedule")).toContain(i18n.t("chat:access.denied"));

    // With a space selected the section is unchanged.
    expect(rows(false).some((li) => li.includes("space-tile-stack"))).toBe(false);
  });

  it("holds its box while the conversation's scope loads", () => {
    const html = summary({ seedSpaces: true, spaceRole: null, conversation: undefined });
    expect(html).toContain("animate-pulse");
  });

  it("lists the capabilities under the caller's role once permissions are known", () => {
    const html = summary({ seedSpaces: true, spaceRole: null });
    expect(html).toContain(i18n.t("chat:access.capability.runAgents"));
    expect(html).not.toContain(i18n.t("chat:access.previewing"));
  });
});

describe("the capability list", () => {
  // The popover body is portalled and closed in this harness, so the list is
  // rendered on its own — it is the part whose structure carries the meaning.
  const capabilities = [
    {
      id: "a",
      labelKey: "access.capability.runAgents",
      held: () => true,
      verdict: "granted",
      spaceIds: ["spc_a"],
    },
    {
      id: "b",
      labelKey: "access.capability.schedule",
      held: () => false,
      verdict: "denied",
      spaceIds: [],
    },
  ] as const;

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

  it("marks a row the composer switch turns off, without calling it refused", () => {
    const create = (verdict: "granted" | "off") => [
      {
        id: "createPackages",
        labelKey: "access.capability.createPackages",
        held: () => true,
        verdict,
        spaceIds: ["spc_a"],
      },
    ];
    const html = render(<ChatCapabilityList capabilities={create("off")} />);
    expect(html).toContain(i18n.t("chat:access.turnedOff"));
    expect(html).not.toContain(i18n.t("chat:access.denied"));
    expect(html).not.toContain("line-through");

    const on = render(<ChatCapabilityList capabilities={create("granted")} />);
    expect(on).not.toContain(i18n.t("chat:access.turnedOff"));
    expect(on).toContain(i18n.t("chat:access.granted"));
  });
});
