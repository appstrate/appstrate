// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { i18nReady } from "../../i18n.ts";
import {
  DashboardSkeleton,
  DetailPageSkeleton,
  ListPageSkeleton,
  SettingsSkeleton,
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
      <DashboardSkeleton />,
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
});
