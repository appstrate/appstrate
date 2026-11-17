// SPDX-License-Identifier: Apache-2.0

/**
 * The chat in « Vue d'ensemble »: what a page holds while the mode is not known, how the
 * conversation panel keeps its lists live across spaces, and the grants the module reads.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { ChatModulePage } = await import("./chat-page.tsx");
const { SpaceTilesOf } = await import("../../components/space-name.tsx");
const { ConversationSpacesControl } = await import("./conversation-spaces.tsx");
const { renderSpaces } = await import("./render-spaces.tsx");
const { ChatSidebar } = await import("./chat-sidebar.tsx");
const { ConversationRuns, ShownFile } = await import("./conversation-sidebar.tsx");
const { useChatCan, useChatTransport } = await import("./use-chat-runtime.ts");
const { useCanReach } = await import("../../hooks/use-can-reach.ts");
const { ACROSS_SPACES_POLL_MS } = await import("../../lib/across-spaces.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");

await i18nReady;
await i18n.changeLanguage("fr");
await i18n.loadNamespaces(["chat"]);

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

const space = (id: string, permissions: string[]) => ({
  id,
  object: "space",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name: id,
  role: null,
});

/** `node` with the overview mode chosen and, when `spaces` is given, the space listing answered. */
function renderOverview(
  node: React.ReactElement,
  spaces?: ReturnType<typeof space>[],
  chosen = true,
): { html: string; queryClient: QueryClient } {
  stubs = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_1", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: chosen ? { "u_1:org_1": true } : {},
    }),
  ];
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        icon: null,
        color: null,
        role: "member",
        deleting_at: null,
        permissions: [],
        createdAt: "2026-09-05T00:00:00Z",
      },
    ],
  );
  if (spaces) {
    queryClient.setQueryData(
      ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
      {
        object: "list",
        hasMore: false,
        data: spaces,
      },
    );
  }
  const html = render(<SidebarProvider>{node}</SidebarProvider>, { queryClient });
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
  const can = (permission: string, chosen: boolean) =>
    renderOverview(<Probe permission={permission} />, spaces, chosen).html;

  it("is what some space where the chat acts grants, in the overview and out of it", () => {
    for (const chosen of [true, false]) {
      expect(can("skills:read", chosen)).toContain("<p>true</p>");
      expect(can("chat:write", chosen)).toContain("<p>true</p>");
      expect(can("files:read", chosen)).toContain("<p>false</p>");
    }
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

  it("filters the list to the selected space, and to none in « Vue d'ensemble »", () => {
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
    expect(html.match(/ring-\(--space-tile-ring,var\(--background\)\)/g)).toHaveLength(2);
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
