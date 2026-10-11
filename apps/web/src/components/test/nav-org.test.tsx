// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import type { components } from "../../api/client.ts";
import { NavOrg } from "../nav-org.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

await i18nReady;
await i18n.changeLanguage("fr");

describe("the main navigation", () => {
  it("ends Construire with Planifications, after Intégrations, and keeps Activité for what happened", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    const org: components["schemas"]["Organization"] = {
      id: "org_nav",
      name: "Nav",
      slug: "nav",
      logo: null,
      role: "owner",
      deleting_at: null,
      permissions: [
        "agents:read",
        "skills:read",
        "integrations:read",
        "schedules:read",
        "files:read",
        "runs:read",
      ],
      createdAt: "2026-09-05T00:00:00Z",
    };
    const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: org.id,
    });
    queryClient.setQueryData(["orgs"], [org]);
    let html: string;
    try {
      html = render(
        <SidebarProvider>
          <NavOrg />
        </SidebarProvider>,
        { queryClient },
      );
    } finally {
      snapshot.mockRestore();
    }
    const at = (label: string) => html.indexOf(`<span>${label}</span>`);
    const order = [
      "Activité",
      "Fichiers",
      "Runs",
      "Construire",
      "Agents",
      "Skills",
      "Intégrations",
      "Planifications",
    ].map((label) =>
      label === "Activité" || label === "Construire" ? html.indexOf(label) : at(label),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
