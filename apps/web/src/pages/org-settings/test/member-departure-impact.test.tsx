// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import type { DepartureImpactItem } from "../../../lib/member-departure.ts";

// The component reaches the space store, which reads `window.location` at import.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});
const { MemberDepartureImpact } = await import("../member-departure-impact.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const base = {
  id: "sch_1",
  space: { id: "spc_team", name: "Sales" },
  actor: { name: "Alice" },
  lost_integrations: [],
} as unknown as DepartureImpactItem;

function item(overrides: Partial<DepartureImpactItem>): DepartureImpactItem {
  return { ...base, ...overrides };
}

describe("MemberDepartureImpact", () => {
  it("says nothing stops when the list is empty", () => {
    const html = render(
      <MemberDepartureImpact impact={{ data: [], isLoading: false, error: null }} />,
    );
    expect(html).toContain(
      "Aucune planification d’un espace d’équipe ne sera désactivée par ce retrait.",
    );
  });

  it("points a leaving actor's schedule to reassignment and names the lost integrations", () => {
    const html = render(
      <MemberDepartureImpact
        impact={{
          data: [item({ cause: "actor_left_org", lost_integrations: ["@a/gmail"] })],
          isLoading: false,
          error: null,
        }}
      />,
    );
    expect(html).toContain("Réassigner");
    expect(html).toContain("Connexion de remplacement requise : @a/gmail");
    expect(html).not.toContain("Choisir une connexion");
  });

  it("points a schedule on a shared connection to choosing another one", () => {
    const html = render(
      <MemberDepartureImpact
        impact={{
          data: [item({ cause: "connection_unshared" })],
          isLoading: false,
          error: null,
        }}
      />,
    );
    expect(html).toContain("Choisir une connexion");
    expect(html).not.toContain("Réassigner");
  });

  it("shows the error state when the read fails", () => {
    const html = render(
      <MemberDepartureImpact
        impact={{
          data: undefined,
          isLoading: false,
          error: {
            type: "about:blank",
            title: "Internal Server Error",
            status: 500,
            detail: "boom",
            code: "internal_error",
            request_id: "req_1",
          },
        }}
      />,
    );
    expect(html).toContain("Impossible de savoir quelles planifications seront désactivées.");
    expect(html).not.toContain("Réassigner");
    expect(html).not.toContain("Aucune planification");
  });
});
