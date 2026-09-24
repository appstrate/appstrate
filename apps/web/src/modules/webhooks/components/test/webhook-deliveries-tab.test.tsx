// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import i18n, { i18nReady } from "@/i18n.ts";
import { render } from "@/test/render.tsx";
import { WebhookDeliveriesTab } from "../webhook-deliveries-tab.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

// Zustand's server snapshot has no selected org; seed that real query key.
const queryKey = [
  "get",
  "/api/webhooks/{id}/deliveries",
  { params: { path: { id: "wh_1" }, header: { "X-Org-Id": undefined } } },
];

function page(eventId: string, hasMore: boolean) {
  return {
    object: "list",
    data: [
      {
        id: `id_${eventId}`,
        eventId,
        eventType: "run.success",
        status: "success",
        statusCode: 200,
        latency: 12,
        attempt: 1,
        error: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    hasMore,
  };
}

function renderPages(pages: ReturnType<typeof page>[], nextPageFailed = false): string {
  const qc = new QueryClient();
  const data = { pages, pageParams: pages.map((_, i) => (i === 0 ? undefined : `p${i}`)) };
  qc.setQueryData(queryKey, data);
  if (nextPageFailed) {
    qc.getQueryCache()
      .find({ queryKey })!
      .setState({
        status: "error",
        error: new Error("boom"),
        fetchMeta: { fetchMore: { direction: "forward" } },
      });
  }
  return render(<WebhookDeliveriesTab webhookId="wh_1" />, { queryClient: qc });
}

describe("WebhookDeliveriesTab", () => {
  it("offers the next page only while the server reports more", () => {
    const more = renderPages([page("evt_1", true)]);
    expect(more).toContain("evt_1");
    expect(more).toContain("Charger plus");
    expect(renderPages([page("evt_1", false)])).not.toContain("Charger plus");
  });

  it("keeps every loaded page on screen when a later page fails, with a retry", () => {
    const html = renderPages([page("evt_1", true), page("evt_2", true)], true);
    expect(html).toContain("evt_1");
    expect(html).toContain("evt_2");
    expect(html).toContain("boom");
    expect(html).toContain("Réessayer");
    expect(html).not.toContain("Charger plus");
  });
});
