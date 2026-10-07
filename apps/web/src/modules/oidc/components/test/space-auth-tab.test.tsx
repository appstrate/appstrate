// SPDX-License-Identifier: Apache-2.0

/**
 * The secret field of the space authentication tab (SMTP password, OAuth client
 * secret). The upsert routes are create-or-replace and the stored secret never
 * comes back, so the field is required on every save, configured or not — the
 * browser then blocks an empty submit — and a configured section says the
 * secret has to be entered again.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { SpaceAuthTab } = await import("../space-auth-tab.tsx");
const { orgStore } = await import("../../../../stores/org-store.ts");
const { spaceStore } = await import("../../../../stores/space-store.ts");
const { render } = await import("../../../../test/render.tsx");
const i18nModule = await import("../../../../i18n.ts");
type SmtpConfigView = import("../../hooks/use-space-auth-config.ts").SmtpConfigView;
type SocialProviderView = import("../../hooks/use-space-auth-config.ts").SocialProviderView;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";
const STAMP = "2026-09-05T10:00:00Z";

const SMTP_HINT =
  "Le mot de passe enregistré n'est jamais affiché : saisissez-le à nouveau à chaque enregistrement.";
const SOCIAL_HINT =
  "Le secret enregistré n'est jamais affiché : saisissez-le à nouveau à chaque enregistrement.";

const SMTP: SmtpConfigView = {
  spaceId: SPACE_ID,
  host: "smtp.example.com",
  port: 587,
  username: "mailer",
  from_address: "noreply@tenant.example.com",
  from_name: null,
  secure_mode: "auto",
  createdAt: STAMP,
  updatedAt: STAMP,
};

const GOOGLE: SocialProviderView = {
  spaceId: SPACE_ID,
  provider: "google",
  client_id: "acme.apps.googleusercontent.com",
  scopes: null,
  createdAt: STAMP,
  updatedAt: STAMP,
};

/** The tab's three sections, in page order, with the rows the cache holds. */
function renderSections(rows: { smtp: SmtpConfigView | null; google: SocialProviderView | null }): {
  smtp: string;
  google: string;
  github: string;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["get", "/api/spaces/{id}/smtp-config", { params: { path: { id: SPACE_ID } } }],
    rows.smtp,
  );
  const social = { google: rows.google, github: null };
  for (const provider of ["google", "github"] as const) {
    queryClient.setQueryData(
      [
        "get",
        "/api/spaces/{id}/social-providers/{provider}",
        { params: { path: { id: SPACE_ID, provider } } },
      ],
      social[provider],
    );
  }
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const current = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    const sections = render(<SpaceAuthTab />, { queryClient })
      .split("<section")
      .slice(1);
    expect(sections).toHaveLength(3);
    const [smtp, google, github] = sections as [string, string, string];
    return { smtp, google, github };
  } finally {
    org.mockRestore();
    current.mockRestore();
  }
}

/**
 * The section's one `<input type="password">` opening tag, so `required` is
 * read off the element itself.
 */
function secretInput(section: string): string {
  const tags = section
    .split("<input")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(">")))
    .filter((tag) => tag.includes('type="password"'));
  expect(tags).toHaveLength(1);
  return tags[0]!;
}

describe("a configured section", () => {
  const rows = { smtp: SMTP, google: GOOGLE };

  it("requires the SMTP password again and says so", () => {
    const { smtp } = renderSections(rows);
    expect(smtp).toContain("Configuré");
    expect(secretInput(smtp)).toContain('required=""');
    expect(smtp).toContain(SMTP_HINT);
  });

  it("requires the client secret again and says so", () => {
    const { google } = renderSections(rows);
    expect(google).toContain("Configuré");
    expect(secretInput(google)).toContain('required=""');
    expect(google).toContain(SOCIAL_HINT);
  });
});

describe("an unconfigured section", () => {
  const rows = { smtp: null, google: GOOGLE };

  it("requires the SMTP password, with no hint about a stored one", () => {
    const { smtp } = renderSections(rows);
    expect(smtp).toContain("Non configuré");
    expect(secretInput(smtp)).toContain('required=""');
    expect(smtp).not.toContain(SMTP_HINT);
  });

  it("requires the client secret, with no hint about a stored one", () => {
    const { github } = renderSections(rows);
    expect(github).toContain("Non configuré");
    expect(secretInput(github)).toContain('required=""');
    expect(github).not.toContain(SOCIAL_HINT);
  });
});
