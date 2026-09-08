// SPDX-License-Identifier: Apache-2.0

/**
 * The two admin-only billing sections: who sees them, what they show, and what
 * a save puts on the wire.
 *
 * Gating is the interesting half. The module's admin routes require
 * `billing:manage`, so
 * that — not the org role — is what mounts the sections: a member who can only
 * READ billing gets the plan cards and nothing else.
 *
 * The picker is a Radix `Popover`, which renders nothing under
 * `renderToStaticMarkup` — what it may offer is pinned in
 * `lib/test/billing-managers`, and the message a refused save produces in
 * `lib/test/billing-error`.
 *
 * The stores read `localStorage` at module init, so the globals are installed
 * before the dynamic imports below.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { $api } = await import("../../api/client.ts");
const { OrgSettingsBillingPage } = await import("../org-settings/billing.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

const i18n = i18nModule.default;
await i18nModule.i18nReady;
await i18n.changeLanguage("fr");

const ORG_ID = "org_a";
const header = { "X-Org-Id": ORG_ID };

const MEMBERS = [
  {
    userId: "usr_owner",
    displayName: "Olivia Ferrand",
    email: "olivia@acme.test",
    role: "owner" as const,
    joinedAt: "2026-01-01T00:00:00Z",
  },
  {
    userId: "usr_admin",
    displayName: "Adam Vidal",
    email: "adam@acme.test",
    role: "admin" as const,
    joinedAt: "2026-01-02T00:00:00Z",
  },
  {
    userId: "usr_member",
    displayName: "Manon Bloch",
    email: "manon@acme.test",
    role: "member" as const,
    joinedAt: "2026-01-03T00:00:00Z",
  },
];

interface SeedOptions {
  permissions: string[];
  managers?: { user_id: string; added_by: string; created_at: string }[];
  contact?: { billing_email: string | null; billing_cc: string[] };
  /** The org read the managers card resolves its rows against fails. */
  orgError?: boolean;
}

function seed({ permissions, managers = [], contact, orgError }: SeedOptions): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/billing", { params: { header } }).queryKey,
    {
      plan: { id: "free", name: "Free" },
      plans: [],
      usage_percent: 0,
      credits_used: 0,
      credit_quota: 5000,
      period_end: null,
      status: "none",
      upgrades: [],
    },
  );
  const orgKey = $api.queryOptions("get", "/api/orgs/{orgId}", {
    params: { path: { orgId: ORG_ID } },
  }).queryKey;
  queryClient.setQueryData(orgKey, { id: ORG_ID, name: "Acme", members: MEMBERS, invitations: [] });
  if (orgError) {
    queryClient
      .getQueryCache()
      .find({ queryKey: orgKey })!
      .setState({
        data: undefined,
        status: "error",
        error: new Error("Organization unavailable"),
        fetchStatus: "idle",
      });
  }
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/billing/managers", { params: { header } }).queryKey,
    { managers },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/billing/contact", { params: { header } }).queryKey,
    contact ?? { billing_email: null, billing_cc: [] },
  );
  return queryClient;
}

/** SSR reads Zustand's hydration snapshot, not its live state. */
function renderPage(options: SeedOptions): string {
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(<OrgSettingsBillingPage />, { queryClient: seed(options) });
  } finally {
    snapshot.mockRestore();
  }
}

/** The managers card alone — the contact card below it has a Save of its own. */
function managersSection(html: string): string {
  return html.slice(
    html.indexOf("Responsables de facturation"),
    html.indexOf("Contact de facturation"),
  );
}

const ADMIN = ["billing:read", "billing:manage"];
const READER = ["billing:read"];

describe("who the admin sections are mounted for", () => {
  it("mounts both for a caller holding billing:manage", () => {
    const html = renderPage({ permissions: ADMIN });
    expect(html).toContain("Responsables de facturation");
    expect(html).toContain("Contact de facturation");
  });

  it("mounts neither for a caller who can only read billing", () => {
    const html = renderPage({ permissions: READER });
    // The page itself still renders — only the two admin sections are absent.
    expect(html).toContain("Plan actuel");
    expect(html).not.toContain("Responsables de facturation");
    expect(html).not.toContain("Contact de facturation");
    // Nothing either admin section shows leaks through a seeded cache entry.
    expect(html).not.toContain("Aucun responsable de facturation");
    expect(html).not.toContain("Les e-mails de facturation sont envoyés");
  });
});

describe("billing managers section", () => {
  it("lists the current managers with their address", () => {
    const html = renderPage({
      permissions: ADMIN,
      managers: [
        { user_id: "usr_member", added_by: "usr_owner", created_at: "2026-02-01T00:00:00Z" },
      ],
    });
    expect(html).toContain("Manon Bloch");
    expect(html).toContain("manon@acme.test");
    expect(html).not.toContain("Aucun responsable de facturation");
  });

  it("says so when the organization has none", () => {
    expect(renderPage({ permissions: ADMIN })).toContain("Aucun responsable de facturation");
  });

  it("offers to add a manager rather than an always-open list", () => {
    expect(renderPage({ permissions: ADMIN })).toContain("Ajouter un responsable");
  });

  it("says why a manager promoted to admin can no longer be saved", () => {
    const html = renderPage({
      permissions: ADMIN,
      managers: [
        { user_id: "usr_admin", added_by: "usr_owner", created_at: "2026-02-01T00:00:00Z" },
      ],
    });
    expect(html).toContain("Adam Vidal");
    expect(html).toContain("gère déjà la facturation via son rôle");
    // The row is explained, not offered for removal — Save is what clears it.
    expect(html).not.toContain("Retirer Adam Vidal");
  });

  it("says why a manager who left the organization can no longer be saved", () => {
    const html = renderPage({
      permissions: ADMIN,
      managers: [
        { user_id: "usr_gone", added_by: "usr_owner", created_at: "2026-02-01T00:00:00Z" },
      ],
    });
    expect(html).toContain("usr_gone");
    expect(html).toContain("n'est plus membre de l'organisation");
    // Save is what removes it, so it must be reachable with no edit made.
    expect(managersSection(html)).not.toContain('disabled="">Enregistrer</button>');
  });

  it("refuses to render a Save at all when the member roster failed to load", () => {
    const html = renderPage({
      permissions: ADMIN,
      orgError: true,
      managers: [
        { user_id: "usr_member", added_by: "usr_owner", created_at: "2026-02-01T00:00:00Z" },
      ],
    });
    // The card is replaced by its error state, so it has no header to slice on.
    const section = html.slice(0, html.indexOf("Contact de facturation"));
    expect(section).toContain("Une erreur est survenue.");
    // With no roster every saved manager reads as gone, the list reads dirty and
    // Save would PUT the empty set — so there must be no Save to press.
    expect(section).not.toContain("Enregistrer");
    expect(section).not.toContain("n'est plus membre de l'organisation");
  });
});

describe("billing contact section", () => {
  it("explains the owners fallback while no address is set", () => {
    const html = renderPage({ permissions: ADMIN });
    expect(html).toContain("Les e-mails de facturation sont envoyés aux propriétaires");
  });

  it("shows the address and its CC list, and no fallback explanation", () => {
    const html = renderPage({
      permissions: ADMIN,
      contact: { billing_email: "compta@acme.test", billing_cc: ["cfo@acme.test"] },
    });
    expect(html).toContain('value="compta@acme.test"');
    expect(html).toContain("cfo@acme.test");
    expect(html).toContain("Revenir aux propriétaires");
    expect(html).not.toContain("Les e-mails de facturation sont envoyés aux propriétaires");
  });
});
