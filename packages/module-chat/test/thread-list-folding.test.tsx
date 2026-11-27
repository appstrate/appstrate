// SPDX-License-Identifier: Apache-2.0

/**
 * The list's date groups fold from their heading, and the fold is remembered per browser. There is
 * no DOM harness in this repo, so the toggle is covered through its pure state function and the
 * rendering through server-rendered HTML seeded from a stubbed storage. A search never renders
 * groups (`groups` is empty while searching), so its results cannot be folded.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { TooltipProvider } from "@appstrate/ui/components/tooltip";

import { ChatConversationList } from "../src/ui/thread-list.tsx";
import { ChatTransportProvider } from "../src/ui/runtime-context.ts";
import { sessionsQueryKey, type SessionsCache } from "../src/ui/sessions.ts";
import {
  COLLAPSED_GROUPS_KEY,
  readCollapsedGroups,
  setGroupFolded,
} from "../src/ui/collapsed-groups.ts";
import { transportOf } from "./fake-request.ts";

const transport = transportOf(() => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a" }));

const store = globalThis as { localStorage?: unknown };
const original = store.localStorage;
afterEach(() => {
  store.localStorage = original;
});

function stubStorage(initial: Record<string, string> = {}, throwing = false) {
  const data = { ...initial };
  store.localStorage = {
    getItem: (k: string) => {
      if (throwing) throw new Error("blocked");
      return data[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error("quota");
      data[k] = v;
    },
  };
  return data;
}

function render(activeId: string | null = null): string {
  const qc = new QueryClient();
  const row = (id: string, title: string) => ({
    id,
    title,
    unread: false,
    generating: false,
    updatedAt: new Date().toISOString(),
    space_ids: ["spc_a"],
  });
  qc.setQueryData<SessionsCache>(sessionsQueryKey("spc_a"), {
    pages: [{ data: [row("chs_1", "Budget"), row("chs_2", "Roadmap")], hasMore: false }],
    pageParams: [undefined],
  });
  return renderToString(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <SidebarProvider>
          <ChatTransportProvider value={transport}>
            <ChatConversationList
              activeId={activeId}
              t={(key) => key}
              can={() => true}
              renderSpaces={(ids) => ids.join(", ")}
            />
          </ChatTransportProvider>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const heading = (html: string) => html.match(/<button[^>]*data-sidebar="group-label"[^>]*>/)?.[0];

describe("a date group's heading", () => {
  it("is a button, open by default, naming its list with aria-controls", () => {
    stubStorage();
    const html = render();
    const button = heading(html);
    expect(button).toContain('aria-expanded="true"');
    const controls = button?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain("Budget");
    expect(html).toMatch(/lucide-chevron-down/);
  });

  it("renders folded, without its rows, when its key was stored as folded", () => {
    stubStorage({ [COLLAPSED_GROUPS_KEY]: JSON.stringify(["today"]) });
    const html = render();
    const button = heading(html);
    expect(button).toContain('aria-expanded="false"');
    expect(html).toContain("threads.group.today");
    // Radix unmounts a folded list and drops aria-controls with it: nothing dangles.
    expect(button).not.toContain("aria-controls");
    expect(html).not.toContain("Budget");
  });

  it("shows only the active row under a folded group's heading, still folded", () => {
    stubStorage({ [COLLAPSED_GROUPS_KEY]: JSON.stringify(["today"]) });
    const html = render("chs_2");
    expect(heading(html)).toContain('aria-expanded="false"');
    expect(html).toContain("Roadmap");
    expect(html).not.toContain("Budget");
  });

  it("shows no row under a folded group that does not hold the active conversation", () => {
    stubStorage({ [COLLAPSED_GROUPS_KEY]: JSON.stringify(["today"]) });
    const html = render("chs_other");
    expect(heading(html)).toContain('aria-expanded="false"');
    expect(html).not.toContain("Roadmap");
    expect(html).not.toContain("Budget");
  });

  it("ignores garbage and unknown keys in the storage", () => {
    for (const raw of ["not json", '{"a":1}', '[1,null,"nope"]']) {
      stubStorage({ [COLLAPSED_GROUPS_KEY]: raw });
      expect(readCollapsedGroups().size).toBe(0);
      expect(heading(render())).toContain('aria-expanded="true"');
    }
  });

  it("renders open when the storage throws", () => {
    stubStorage({}, true);
    expect(heading(render())).toContain('aria-expanded="true"');
  });
});

describe("folding state", () => {
  it("folds and unfolds a key, writing the set through to the storage", () => {
    const data = stubStorage();
    const folded = setGroupFolded(new Set(), "today", true);
    expect([...folded]).toEqual(["today"]);
    expect(JSON.parse(data[COLLAPSED_GROUPS_KEY]!)).toEqual(["today"]);
    expect(readCollapsedGroups().has("today")).toBe(true);

    const unfolded = setGroupFolded(folded, "today", false);
    expect(unfolded.size).toBe(0);
    expect(JSON.parse(data[COLLAPSED_GROUPS_KEY]!)).toEqual([]);
  });

  it("still folds in memory when the storage refuses the write", () => {
    stubStorage({}, true);
    const folded = setGroupFolded(new Set(), "week", true);
    expect(folded.has("week")).toBe(true);
  });
});
