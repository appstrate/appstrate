// SPDX-License-Identifier: Apache-2.0

/**
 * The chat in « Tous les espaces »: what a page holds while the mode is not known, how the
 * conversation panel keeps its lists live across spaces, and the grants the module reads.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Route, Routes } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { renderInSpace, memberSpaceClient, testSpace } = await import("../../test/space-context.ts");
const { makeRun } = await import("../../test/run-fixture.ts");
const { fileFixture } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { ChatModulePage } = await import("./chat-page.tsx");
const { SpaceTilesOf } = await import("../../components/space-name.tsx");
const { renderSpaces } = await import("./render-spaces.tsx");
const { ChatSidebar } = await import("./chat-sidebar.tsx");
const crumbTitle = await import("./chat-crumb-title.ts");
const { sessionsQueryKey } = await import("../../../../../packages/module-chat/src/ui/sessions.ts");
const { ConversationFiles, ConversationRuns, ShownFile } =
  await import("./conversation-sidebar.tsx");
const { useConversationTabs } = await import("./use-conversation-tabs.ts");
const { useChatCan, useChatTransport } = await import("./use-chat-runtime.ts");
const { usePermissions } = await import("../../hooks/use-permissions.ts");
const { useCanReach } = await import("../../hooks/use-can-reach.ts");
const { ACROSS_SPACES_POLL_MS } = await import("../../lib/across-spaces.ts");

await i18nReady;
await i18n.changeLanguage("fr");
await i18n.loadNamespaces(["chat"]);

const space = (id: string, permissions: string[]) => testSpace(id, permissions, id);

/** `node` with the overview mode chosen and, when `spaces` is given, the space listing answered. */
function renderOverview(
  node: React.ReactElement,
  spaces?: ReturnType<typeof space>[],
  chosen = true,
): { html: string; queryClient: QueryClient } {
  const queryClient = memberSpaceClient(spaces ?? []);
  // No listing yet: the mode is not known.
  if (!spaces) queryClient.removeQueries({ queryKey: ["get", "/api/spaces"] });
  const html = renderInSpace(<SidebarProvider>{node}</SidebarProvider>, {
    queryClient,
    overview: chosen,
  });
  return { html, queryClient };
}

describe("the chat while the mode is not known", () => {
  it("holds the page's shape, not a blank, until the space listing answers", () => {
    const { html } = renderOverview(<ChatModulePage />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Chargement");
  });

  it("publishes the trail from the page, with no list mounted (a phone's closed drawer)", () => {
    const trail = spyOn(crumbTitle, "chatTrailEntries");
    try {
      const queryClient = memberSpaceClient([]);
      queryClient.removeQueries({ queryKey: ["get", "/api/spaces"] });
      renderInSpace(
        <SidebarProvider>
          <Routes>
            <Route path="/chat/:conversationId" element={<ChatModulePage />} />
          </Routes>
        </SidebarProvider>,
        { queryClient, overview: true, initialEntries: ["/chat/chs_1"] },
      );
      // The conversation's name slot is held while the mode is not known.
      expect(trail).toHaveBeenCalledWith("Chat", null, true);
    } finally {
      trail.mockRestore();
    }
  });

  it("leaves the trail to the page: the list publishes none", () => {
    const trail = spyOn(crumbTitle, "chatTrailEntries");
    try {
      renderOverview(<ChatSidebar />);
      expect(trail).not.toHaveBeenCalled();
    } finally {
      trail.mockRestore();
    }
  });

  it("holds the list's shape, with the real « new conversation » row", () => {
    const { html } = renderOverview(<ChatSidebar />);
    expect(html).toContain("Nouvelle conversation");
    expect(html).toContain('data-sidebar="menu-skeleton"');
  });
});

describe("the chat's trail once the mode is known", () => {
  it("names the open conversation in the trail from the page once the mode is known", () => {
    const trail = spyOn(crumbTitle, "chatTrailEntries");
    // The thread reads the page's visibility: a document, no DOM or effects.
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible" },
    });
    try {
      const queryClient = memberSpaceClient([space("spc_a", ["chat:read", "chat:write"])]);
      queryClient.setQueryData(sessionsQueryKey("spc_a"), {
        pages: [
          {
            data: [
              {
                id: "chs_1",
                title: "Budget",
                unread: false,
                generating: false,
                updatedAt: "",
                spaceId: "spc_a",
                restricted: false,
                space_ids: ["spc_a"],
              },
            ],
            hasMore: false,
          },
        ],
        pageParams: [undefined],
      });
      renderInSpace(
        <SidebarProvider>
          <Routes>
            <Route path="/chat/:conversationId" element={<ChatModulePage />} />
          </Routes>
        </SidebarProvider>,
        { queryClient, overview: true, initialEntries: ["/chat/chs_1"] },
      );
      expect(trail).toHaveBeenCalledWith("Chat", "Budget", false);
    } finally {
      trail.mockRestore();
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});

describe("the conversation panel", () => {
  const spaces = [
    space("spc_a", ["chat:read", "chat:write", "mcp:read", "runs:read"]),
    space("spc_b", ["chat:read", "chat:write", "mcp:read", "runs:read"]),
  ];

  it("polls the runs of every space: the SSE stream carries the working space only", () => {
    const { queryClient } = renderOverview(
      <ConversationRuns conversationId="chs_1" active />,
      spaces,
    );
    const query = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["get", "/api/orgs/{orgId}/runs"] })[0];
    expect(query).toBeDefined();
    expect((query!.options as { refetchInterval?: unknown }).refetchInterval).toBe(
      ACROSS_SPACES_POLL_MS,
    );
  });

  /** The panel's list once its query answered with `rows`, under `spaces`. */
  function listed(
    node: React.ReactElement,
    spaces: ReturnType<typeof space>[],
    path: string,
    rows: unknown[],
  ): string {
    const { queryClient } = renderOverview(node, spaces);
    const query = queryClient
      .getQueryCache()
      .getAll()
      .find((q) => JSON.stringify(q.queryKey).includes(`"${path}"`));
    queryClient.setQueryData(query!.queryKey, { object: "list", hasMore: false, data: rows });
    return renderInSpace(<SidebarProvider>{node}</SidebarProvider>, {
      queryClient,
      overview: true,
    });
  }

  it("names each run's and file's space only when several spaces admit the list", () => {
    const runs = [makeRun({ id: "run_b", spaceId: "spc_b" })];
    const files = [fileFixture({ name: "b.md", spaceId: "spc_b" })];
    const both = (permission: string) => [
      testSpace("spc_a", ["chat:read", permission]),
      testSpace("spc_b", ["chat:read", permission]),
    ];
    const one = (permission: string) => [
      testSpace("spc_a", ["chat:read", permission]),
      testSpace("spc_b", ["chat:read"]),
    ];
    const runList = <ConversationRuns conversationId="chs_1" active />;
    const fileList = <ConversationFiles conversationId="chs_1" active onSelect={() => {}} />;
    // The row is drawn either way; only its space's name depends on how many spaces admit the list.
    const cases: [React.ReactElement, string, string, unknown[], string][] = [
      [runList, "runs:read", "/api/orgs/{orgId}/runs", runs, "#42"],
      [fileList, "files:read", "/api/orgs/{orgId}/files", files, "b.md"],
    ];
    for (const [list, permission, path, rows, row] of cases) {
      const several = listed(list, both(permission), path, rows);
      const single = listed(list, one(permission), path, rows);
      expect(several).toContain(row);
      expect(single).toContain(row);
      expect(several).toContain("Studio");
      expect(single).not.toContain("Studio");
    }
  });

  function Tabs() {
    return (
      <p>
        {useConversationTabs("runs")
          .tabs.map(({ id }) => id)
          .join(",")}
      </p>
    );
  }

  it("lists the runs and files tabs where some space admits them, beside Summary and Tools", () => {
    expect(renderOverview(<Tabs />, spaces).html).toContain("<p>summary,runs,tools</p>");
    const files = [space("spc_a", ["chat:read"]), space("spc_b", ["chat:read", "files:read"])];
    expect(renderOverview(<Tabs />, files).html).toContain("<p>summary,files,tools</p>");
    expect(renderOverview(<Tabs />, [space("spc_a", ["chat:read"])]).html).toContain(
      "<p>summary,tools</p>",
    );
  });

  it("lists the runs and files tabs for a role without the Studio: the chat keeps its data", () => {
    const chatOnly = [
      testSpace("spc_a", ["chat:read", "runs:read", "files:read"], "spc_a", { studio: false }),
    ];
    expect(renderOverview(<Tabs />, chatOnly).html).toContain("<p>summary,runs,files,tools</p>");
  });

  it("lists a run of a space without the Studio, unlinked: its page is a Studio screen", () => {
    const runs = [makeRun({ id: "run_a", spaceId: "spc_a", packageId: "@acme/reporter" })];
    const html = (studio: boolean) =>
      listed(
        <ConversationRuns conversationId="chs_1" active />,
        [testSpace("spc_a", ["chat:read", "runs:read"], "spc_a", { studio })],
        "/api/orgs/{orgId}/runs",
        runs,
      );
    expect(html(false)).toContain("#42");
    expect(html(false)).not.toContain("/runs/run_a");
    expect(html(true)).toContain("/runs/run_a");
  });
});

describe("the grants the chat module reads", () => {
  // The working space (spc_a) reads files but is no place the chat acts; spc_b is, and reads skills.
  const spaces = [
    space("spc_a", ["chat:read", "files:read", "runs:read"]),
    space("spc_b", ["chat:read", "chat:write", "mcp:read", "skills:read", "runs:read"]),
  ];

  function Probe({ permission }: { permission: string }) {
    return <p>{String(useChatCan()(permission))}</p>;
  }
  const can = (permission: string) =>
    renderOverview(<Probe permission={permission} />, spaces).html;

  // The rule itself is `grantedInSomeActingSpace` (`lib/test/space-lists.test.ts`): this pins the wiring.
  it("keeps an administrator grant absent from the previewed space out of both the working gate and the chat", () => {
    const qc = memberSpaceClient([space("spc_a", ["chat:read", "chat:write", "mcp:read"])]);
    qc.setQueryData(
      ["orgs"],
      [{ id: "org_1", name: "Acme", role: "admin", permissions: ["files:read"] }],
    );
    function Gates() {
      return (
        <p>
          {String(usePermissions().can("files:read"))}|{String(useChatCan()("files:read"))}
        </p>
      );
    }
    expect(
      renderInSpace(<Gates />, { queryClient: qc, overview: false, spaceId: "spc_a" }),
    ).toContain("<p>false|false</p>");
  });

  it("reads each space's effective grants", () => {
    expect(can("skills:read")).toContain("<p>true</p>");
    expect(can("files:read")).toContain("<p>false</p>");
  });
});

describe("the chat's transport", () => {
  const spaces = [
    space("spc_a", ["chat:read", "chat:write", "mcp:read", "runs:read"]),
    space("spc_b", ["chat:read", "chat:write", "mcp:read", "runs:read"]),
  ];

  function Filter() {
    const transport = useChatTransport();
    return <p>{transport ? `${transport.orgId}|${String(transport.spaceId)}` : "none"}</p>;
  }
  const filter = (chosen: boolean, list = spaces) => renderOverview(<Filter />, list, chosen).html;

  it("filters the list to the selected space, and to none in « Tous les espaces »", () => {
    expect(filter(false)).toContain("<p>org_1|spc_a</p>");
    expect(filter(true)).toContain("<p>org_1|null</p>");
  });

  it("is not there until the space listing has answered", () => {
    expect(renderOverview(<Filter />, undefined, true).html).toContain("<p>none</p>");
  });
});

describe("a file of another space in the context panel", () => {
  const spaces = [
    space("spc_a", ["chat:read", "files:read", "runs:read"]),
    space("spc_b", ["chat:read", "files:read", "runs:read"]),
  ];

  it("is read in its own space, not the working one", () => {
    const { queryClient } = renderOverview(
      <ShownFile
        file={{ id: "file_1", name: "a.md", spaceId: "spc_b" }}
        from="thread"
        onClose={() => {}}
      />,
      spaces,
    );
    const [query] = queryClient.getQueryCache().findAll({ queryKey: ["get", "/api/files/{id}"] });
    expect(query).toBeDefined();
    expect(JSON.stringify(query!.queryKey)).toContain('"X-Space-Id":"spc_b"');
  });

  it("is read in the working space when it is that space's", () => {
    const { queryClient } = renderOverview(
      <ShownFile
        file={{ id: "file_1", name: "a.md", spaceId: "spc_a" }}
        from="thread"
        onClose={() => {}}
      />,
      spaces,
    );
    const [query] = queryClient.getQueryCache().findAll({ queryKey: ["get", "/api/files/{id}"] });
    expect(JSON.stringify(query!.queryKey)).toContain('"X-Space-Id":"spc_a"');
  });
});

describe("the stream's chat channel", () => {
  // `useGlobalRunSync` opens it when the chat is reachable: wherever some space reads it, whichever
  // space is working and whatever the mode.
  function Reach() {
    return <p>{String(useCanReach()("/chat"))}</p>;
  }
  const withChat = (check: () => void) => {
    const config = window.__APP_CONFIG__;
    window.__APP_CONFIG__ = { ...config, features: { ...config.features, chat: true } };
    try {
      check();
    } finally {
      window.__APP_CONFIG__ = config;
    }
  };

  it("is wanted, in the overview or not, when another space than the working one reads the chat", () => {
    withChat(() => {
      const spaces = [space("spc_a", ["runs:read"]), space("spc_b", ["chat:read", "runs:read"])];
      expect(renderOverview(<Reach />, spaces, true).html).toContain("<p>true</p>");
      expect(renderOverview(<Reach />, spaces, false).html).toContain("<p>true</p>");
    });
  });

  it("is not wanted while the chat is turned off, whatever the spaces grant", () => {
    const spaces = [space("spc_a", ["chat:read"]), space("spc_b", ["chat:read"])];
    expect(renderOverview(<Reach />, spaces, true).html).toContain("<p>false</p>");
    expect(renderOverview(<Reach />, spaces, false).html).toContain("<p>false</p>");
  });

  it("is not wanted, in either mode, when no space reads the chat", () => {
    withChat(() => {
      const spaces = [space("spc_a", ["runs:read"]), space("spc_b", ["files:read"])];
      expect(renderOverview(<Reach />, spaces, true).html).toContain("<p>false</p>");
      expect(renderOverview(<Reach />, spaces, false).html).toContain("<p>false</p>");
    });
  });
});

describe("the spaces a conversation touched", () => {
  const named = (id: string, name: string) => ({
    ...space(id, ["chat:read", "runs:read"]),
    name,
    icon: null,
    color: null,
  });
  const spaces = [named("spc_a", "Studio"), named("spc_b", "Coffre"), named("spc_c", "Atelier")];
  // An identity tile (the « +N » count is not one).
  const tiles = (html: string) => html.match(/overflow-hidden @container/g)?.length ?? 0;

  it("draws one tile per touched space in a list row, then the names joined", () => {
    const { html } = renderOverview(<>{renderSpaces(["spc_a", "spc_b", "spc_c"])}</>, spaces);
    expect(tiles(html)).toBe(3);
    expect(html).toContain("Studio, Coffre, Atelier");
    expect(html).not.toContain("+2");
  });

  it("rings the stacked tiles in the container's variable, the page background by default", () => {
    const { html } = renderOverview(<SpaceTilesOf spaceIds={["spc_a", "spc_b"]} />, spaces);
    expect(html.match(/ring-\(--tile-ring,var\(--background\)\)/g)).toHaveLength(2);
  });

  it("reads a single space as the usual tile and name", () => {
    const { html } = renderOverview(<SpaceTilesOf spaceIds={["spc_b"]} />, spaces);
    expect(tiles(html)).toBe(1);
    expect(html).toContain("Coffre");
  });

  it("leaves the spaces the reader does not reach out", () => {
    const { html } = renderOverview(<SpaceTilesOf spaceIds={["spc_a", "spc_gone"]} />, spaces);
    expect(tiles(html)).toBe(1);
  });
});
