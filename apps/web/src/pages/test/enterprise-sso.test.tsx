// SPDX-License-Identifier: Apache-2.0

/** Enterprise sign-in settings: owners change, admins read; enforcing says what it still lacks. */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { SsoSettings } from "../../lib/org-sso.ts";

// The page reaches the auth client, which reads `window.location` at import.
installFakeStorage({
  __APP_CONFIG__: { features: { microsoftAuth: true, enterpriseSso: true }, trustedOrigins: [] },
  location: { origin: "http://localhost" },
});
const { OrgSettingsEnterpriseSsoPage } = await import("../org-settings/enterprise-sso.tsx");

await i18nReady;
await i18n.changeLanguage("fr");
const fr = (key: string) => i18n.t(key, { ns: "settings" });
/** A button labelled `key` (a sentence may name the same word). */
const button = (key: string) => `>${fr(key)}</button>`;

const restores: Array<() => void> = [];
afterEach(() => {
  restores.splice(0).forEach((restore) => restore());
});

const ORG_ID = "org_sso";

function settings(overrides: Partial<SsoSettings> = {}): SsoSettings {
  return {
    tenant_id: null,
    tenant_linked_at: null,
    join_role: "member",
    enforced: false,
    enforced_at: null,
    caller_tenant_id: null,
    domains: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        domain: "example.com",
        verified: false,
        verified_at: null,
        txt_record_name: "_appstrate.example.com",
        txt_record_value: "appstrate-domain-verification=abc",
        createdAt: "2026-11-13T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderAs(role: "owner" | "admin", data: SsoSettings): string {
  const permissions = role === "owner" ? ["org-sso:read", "org-sso:write"] : ["org-sso:read"];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: ORG_ID,
    name: "Org",
    slug: "org",
    icon: null,
    color: null,
    role,
    deleting_at: null,
    permissions,
    createdAt: "2026-11-13T00:00:00Z",
  };
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  restores.push(() => snapshot.mockRestore());
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/org-sso", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    data,
  );
  return render(<OrgSettingsEnterpriseSsoPage />, { queryClient });
}

describe("enterprise sign-in settings", () => {
  it("offers an owner the tenant connection and the domain's TXT record", () => {
    const html = renderAs("owner", settings());
    expect(html).toContain(button("orgSso.connect"));
    expect(html).toContain(button("orgSso.addDomain"));
    expect(html).toContain(button("orgSso.verify"));
    expect(html).toContain("_appstrate.example.com");
    expect(html).toContain("appstrate-domain-verification=abc");
    expect(html).not.toContain(fr("orgSso.readOnly"));
  });

  it("shows an admin the same state without a single deed", () => {
    const html = renderAs("admin", settings());
    expect(html).toContain(fr("orgSso.readOnly"));
    expect(html).toContain("_appstrate.example.com");
    expect(html).not.toContain(button("orgSso.connect"));
    expect(html).not.toContain(button("orgSso.addDomain"));
    expect(html).not.toContain(button("orgSso.verify"));
    expect(html).not.toContain(button("orgSso.enforce"));
  });

  it("says why the enforcement waits, and offers the Microsoft sign-in it lacks", () => {
    expect(renderAs("owner", settings())).toContain(fr("orgSso.blockerNoTenant"));
    const otherSession = renderAs(
      "owner",
      settings({
        tenant_id: "tid-org",
        caller_tenant_id: null,
        domains: [
          { ...settings().domains[0]!, verified: true, verified_at: "2026-11-13T00:00:00Z" },
        ],
      }),
    );
    expect(otherSession).toContain(fr("orgSso.blockerOtherSession"));
    expect(otherSession).toContain(button("orgSso.signInMicrosoft"));
  });

  it("locks unlinking while Microsoft is required, and offers to lift it", () => {
    const html = renderAs(
      "owner",
      settings({
        tenant_id: "tid-org",
        caller_tenant_id: "tid-org",
        enforced: true,
        enforced_at: "2026-11-13T00:00:00Z",
        domains: [
          { ...settings().domains[0]!, verified: true, verified_at: "2026-11-13T00:00:00Z" },
        ],
      }),
    );
    expect(html).toContain(button("orgSso.lift"));
    expect(html).toContain(fr("orgSso.unlinkEnforced"));
    expect(html).toContain(fr("orgSso.removeEnforced"));
  });
});
