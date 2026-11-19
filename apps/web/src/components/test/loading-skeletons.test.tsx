// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import {
  ChatConversationSkeleton,
  ChatPanelSkeleton,
  DashboardBodySkeleton,
  DashboardSkeleton,
  DetailPageSkeleton,
  ListPageSkeleton,
  OverlayPanelSkeleton,
  ScheduleDetailSkeleton,
  SettingsSkeleton,
  SettingsTableSkeleton,
  TextSkeleton,
} from "../loading-skeletons.tsx";
import { render } from "../../test/render.tsx";
import { ConversationSkeleton } from "@appstrate/module-chat/conversation-skeleton";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { QueryClient } from "@tanstack/react-query";
import { orgStore } from "../../stores/org-store";

const count = (html: string, needle: string) => html.split(needle).length - 1;

await i18nReady;

describe("loading skeletons", () => {
  it("announce one status and hide their blocks from assistive technology", () => {
    for (const node of [
      <TextSkeleton />,
      <SettingsSkeleton />,
      <DetailPageSkeleton tabCount={3} />,
      <ListPageSkeleton />,
      <DashboardBodySkeleton />,
      <ChatPanelSkeleton />,
      <ChatConversationSkeleton />,
      <SettingsTableSkeleton />,
    ]) {
      const html = render(node);
      expect(count(html, 'role="status"')).toBe(1);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("animate-spin");
    }
  });

  it("draws as many lines as the text it stands in for", () => {
    expect(count(render(<TextSkeleton lines={5} />), "animate-pulse")).toBe(5);
  });

  it("keeps a collection page header's box, so the real title lands in place", () => {
    expect(render(<ListPageSkeleton />)).toContain("data-page-header");
  });

  it("draws the action placeholder only for a page that has actions", () => {
    const placeholder = "h-8 w-24 shrink-0";
    expect(render(<ListPageSkeleton />)).toContain(placeholder);
    expect(render(<ListPageSkeleton actions={false} />)).not.toContain(placeholder);
  });

  it("waits as cards for a collection its reader sees as cards, as a table otherwise", () => {
    // Integrations default to cards; agents to a table.
    const cardGrid = "grid-cols-[repeat(auto-fill";
    expect(render(<ListPageSkeleton list="integrations" />)).toContain(cardGrid);
    expect(render(<ListPageSkeleton list="agent" />)).not.toContain(cardGrid);
  });

  it("draws a settings table frameless, as the panel's integrated surface does", () => {
    const html = render(<SettingsTableSkeleton />);
    expect(html).not.toContain("bg-card");
    expect(html).toContain("border-y");
    expect(render(<SettingsTableSkeleton toolbar />)).toContain("sm:max-w-[280px]");
  });

  it("draws what ends a collection's bar only where the page has it", () => {
    const views = "h-8 w-[5.25rem]";
    expect(render(<ListPageSkeleton list="integrations" views />)).toContain(views);
    expect(render(<ListPageSkeleton />)).not.toContain(views);
  });

  it("waits as file tiles for the gallery shown as cards", () => {
    expect(render(<ListPageSkeleton list="documents" views actions={false} />)).toContain(
      "aspect-square",
    );
  });

  it("draws a settings table's intro and search-only bar", () => {
    const html = render(<SettingsTableSkeleton toolbar intro="hint" />);
    expect(html).toContain("sm:max-w-[280px]");
    expect(html).toContain("max-w-2xl");
    expect(html).not.toContain("w-[5.5rem]");
    expect(render(<SettingsTableSkeleton toolbar columns />)).toContain("w-[6.5rem]");
  });

  it("draws an overlay's table frameless and a page's in its card", () => {
    expect(render(<OverlayPanelSkeleton list />)).not.toContain("bg-card");
    expect(render(<ListPageSkeleton />)).toContain("bg-card");
  });

  it("draws the dashboard's title row with the line under it", () => {
    const html = render(<DashboardSkeleton />);
    expect(html).toContain("data-page-header");
    expect(html).toContain("mt-1 w-56");
  });

  it("holds a reader's read-only note, not a composer, in the chat", () => {
    // No permission loaded: the reader's shape.
    const html = render(<ChatPanelSkeleton />);
    expect(html).toContain("h-[46px]");
    expect(html).not.toContain("h-[30px]");
  });

  it("uses the module's exact conversation wait for the route fallback", () => {
    expect(render(<ChatConversationSkeleton />)).toBe(
      render(
        <ConversationSkeleton
          label={i18n.t("common:loading")}
          placeholder={null}
          disclaimer={null}
        />,
      ),
    );
  });

  it("shares the writer's composer shape without waiting for the chat namespace", () => {
    const qc = new QueryClient();
    qc.setQueryData(["orgs"], [{ id: "org_writer", permissions: ["chat:write"] }]);
    const org = spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_writer",
    });
    try {
      expect(render(<ChatConversationSkeleton />, { queryClient: qc })).toBe(
        render(
          <ConversationSkeleton
            label={i18n.t("common:loading")}
            placeholder={<Skeleton className="h-4 w-48" />}
            disclaimer={<Skeleton className="mx-auto my-0.5 h-3 w-64" />}
          />,
        ),
      );
    } finally {
      org.mockRestore();
      qc.clear();
    }
  });

  it("keeps the thread's 42rem column for a stored conversation", () => {
    expect(render(<ChatConversationSkeleton />)).toContain("max-w-2xl");
  });
});

describe("detail page skeleton", () => {
  // The rail split's grid, which only a framed settings tab draws.
  const rail = "grid-cols-[14rem_minmax(0,1fr)]";

  it("draws the tab the address opens on, not always the first one", () => {
    const at = (hash: string) =>
      render(<ScheduleDetailSkeleton />, { initialEntries: [`/schedules/sched_1${hash}`] });
    expect(at("#settings")).toContain(rail);
    expect(at("#runs")).toContain("sm:max-w-[280px]");
    expect(at("")).not.toContain(rail);
    expect(at("")).not.toContain("sm:max-w-[280px]");
  });
});
