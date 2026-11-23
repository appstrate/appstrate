// SPDX-License-Identifier: Apache-2.0

/**
 * The chat in « Tous les espaces »: what a page holds while the mode is not known, how the
 * conversation panel keeps its lists live across spaces, and the grants the module reads.
 */

import { describe, expect, it } from "bun:test";
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
const { ConversationSpacesControl } = await import("./conversation-spaces.tsx");
const { ChatSidebar } = await import("./chat-sidebar.tsx");
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

  it("holds the list's shape, with the real « new conversation » row", () => {
    const { html } = renderOverview(<ChatSidebar />);
    expect(html).toContain("Nouvelle conversation");
    expect(html).toContain('data-sidebar="menu-skeleton"');
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

  it("lists the runs and files tabs where some space admits them, else Info alone", () => {
    expect(renderOverview(<Tabs />, spaces).html).toContain("<p>runs,info</p>");
    const files = [space("spc_a", ["chat:read"]), space("spc_b", ["chat:read", "files:read"])];
    expect(renderOverview(<Tabs />, files).html).toContain("<p>files,info</p>");
    expect(renderOverview(<Tabs />, [space("spc_a", ["chat:read"])]).html).toContain("<p>info</p>");
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
        backToList={false}
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
        backToList={false}
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

  it("draws one tile per space in the top bar's trigger, named for assistive tech", () => {
    const { html } = renderOverview(
      <ConversationSpacesControl spaces={spaces.slice(0, 2)} />,
      spaces,
    );
    expect(tiles(html)).toBe(2);
    expect(html).toContain("Espaces de la conversation : ");
    expect(html).not.toContain("+");
  });

  it("counts the spaces past the visible tiles", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => ({
      ...spaces[0]!,
      id: `spc_${id}`,
      name: id,
    }));
    const { html } = renderOverview(<ConversationSpacesControl spaces={many} />, spaces);
    expect(tiles(html)).toBe(3);
    expect(html).toContain("+2");
  });

  it("draws nothing for a conversation that touched no space", () => {
    const { html } = renderOverview(<ConversationSpacesControl spaces={[]} />, spaces);
    expect(html).not.toContain("conversation-spaces");
  });
});
