// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "@/api/client";
import i18n, { i18nReady } from "@/i18n.ts";
import { render } from "@/test/render.tsx";
import { WebhookDeliveriesTab } from "../webhook-deliveries-tab.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

function renderWithPage(hasMore: boolean): string {
  const qc = new QueryClient();
  // Zustand's server snapshot has no selected org; seed that real query key.
  const params = { path: { id: "wh_1" }, query: {}, header: { "X-Org-Id": undefined } };
  qc.setQueryData($api.queryOptions("get", "/api/webhooks/{id}/deliveries", { params }).queryKey, {
    object: "list",
    data: [
      {
        id: "0b6f3c1e-8f0a-4c52-9d7e-2a1b3c4d5e6f",
        eventId: "evt_1",
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
  });
  return render(<WebhookDeliveriesTab webhookId="wh_1" />, { queryClient: qc });
}

describe("WebhookDeliveriesTab", () => {
  it("offers the next page only while the server reports more", () => {
    const more = renderWithPage(true);
    expect(more).toContain("evt_1");
    expect(more).toContain("Charger plus");
    expect(renderWithPage(false)).not.toContain("Charger plus");
  });
});
