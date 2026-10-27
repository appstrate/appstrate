// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import {
  ChatConversationSkeleton,
  ChatPanelSkeleton,
  DashboardBodySkeleton,
  DetailPageSkeleton,
  ListPageSkeleton,
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

  it("waits as cards for a collection its reader sees as cards, as a table otherwise", () => {
    // Integrations default to cards; agents to a table.
    expect(render(<ListPageSkeleton list="integrations" />)).toContain("h-28");
    expect(render(<ListPageSkeleton list="agent" />)).not.toContain("h-28");
  });

  it("draws a settings table frameless, as the panel's integrated surface does", () => {
    const html = render(<SettingsTableSkeleton />);
    expect(html).not.toContain("bg-card");
    expect(html).toContain("border-y");
    expect(render(<SettingsTableSkeleton toolbar />)).toContain("sm:max-w-[280px]");
  });

  it("holds a reader's read-only note, not a composer and its suggestions, in the chat", () => {
    // No permission loaded: the reader's shape.
    const html = render(<ChatPanelSkeleton />);
    expect(html).toContain("h-[46px]");
    expect(html).not.toContain("h-[38px]");
  });

  it("uses the module's exact conversation wait for the route fallback", () => {
    expect(render(<ChatConversationSkeleton />)).toBe(
      render(<ConversationSkeleton label={i18n.t("common:loading")} placeholder={null} />),
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
            placeholder={<Skeleton className="h-3.5 w-48" />}
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
