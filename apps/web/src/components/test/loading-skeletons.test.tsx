// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { i18nReady } from "../../i18n.ts";
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

  it("keeps the thread's 42rem column for a stored conversation", () => {
    expect(render(<ChatConversationSkeleton />)).toContain("max-w-2xl");
  });
});
