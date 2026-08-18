// SPDX-License-Identifier: Apache-2.0

/**
 * Identity-extraction conformance for the shipped system packages.
 *
 * Every `identity_claims` entry in a manifest is a hand-written accessor into
 * a third-party JSON payload — `$.data.email`, `$.team_user.user_id`,
 * `$.identity.email_address`. A typo in one of those paths does not throw and
 * does not warn: `readPath` returns `""`, `extractIdentity` falls back to
 * `"default"`, and the connection is silently labelled "Connexion N" with an
 * account key that collides with every other connection on that provider. The
 * defect is invisible until someone connects two accounts and cannot tell them
 * apart.
 *
 * So each mapping is exercised here against a payload copied from that
 * provider's own documentation, asserting the account key that comes out. The
 * fixtures are trimmed to the fields the mapping reads plus enough shape to
 * keep the nesting honest.
 *
 * The suite also gates COVERAGE both ways: a manifest that declares
 * `identity_claims` with no fixture fails, and a fixture for a package that no
 * longer declares them fails. Without that, adding an integration would
 * quietly opt it out of the check.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { loadSystemPackages } from "@appstrate/core/system-packages";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { extractIdentity } from "../../../src/services/integration-connections.ts";

const ARCHIVE_DIR = join(import.meta.dir, "../../../../../system-packages");

interface Case {
  /** Auth key the fixture belongs to. */
  authKey: string;
  /** Identity source as the connect strategy assembles it (token response +
   *  `id_token` claims + userinfo body), trimmed to the read fields. */
  source: Record<string, unknown>;
  /** Account key the mapping must resolve to. */
  accountId: string;
  /** Documentation the payload shape was taken from. */
  source_doc: string;
}

const CASES: Record<string, Case> = {
  "@appstrate/airtable": {
    authKey: "primary",
    source: { id: "usrL2PNC5o3H4lBEi", email: "pierre@example.com", scopes: ["data.records:read"] },
    accountId: "pierre@example.com",
    source_doc: "airtable.com/developers/web/api/get-user-id-scopes",
  },
  "@appstrate/asana": {
    authKey: "primary",
    source: {
      data: {
        gid: "12345",
        resource_type: "user",
        name: "Greg Sanchez",
        email: "gsanchez@example.com",
      },
    },
    accountId: "gsanchez@example.com",
    source_doc: "developers.asana.com/reference/getuser",
  },
  "@appstrate/basecamp": {
    authKey: "primary",
    source: {
      expires_at: "2012-03-22T16:56:48-05:00",
      identity: {
        id: 9999999,
        first_name: "Jason",
        last_name: "Fried",
        email_address: "jason@basecamp.com",
      },
      accounts: [{ product: "bc3", id: 99999999, name: "Honcho Design" }],
    },
    accountId: "jason@basecamp.com",
    source_doc: "github.com/basecamp/api — sections/authentication.md",
  },
  "@appstrate/calendly": {
    authKey: "primary",
    source: {
      resource: {
        uri: "https://api.calendly.com/users/AAAA",
        name: "Jane Doe",
        email: "jane@example.com",
        slug: "janedoe",
      },
    },
    accountId: "jane@example.com",
    source_doc: "developer.calendly.com/how-to-find-the-organization-or-user-uri",
  },
  "@appstrate/canva": {
    authKey: "primary",
    source: { team_user: { user_id: "oUnPjZ2k2yuhftbWF7873o", team_id: "oUnPjZ2k2yuhftbWF7873o" } },
    accountId: "oUnPjZ2k2yuhftbWF7873o",
    source_doc: "canva.dev/docs/connect/api-reference/users/users-me",
  },
  "@appstrate/clickup": {
    authKey: "primary",
    source: { user: { id: 123, username: "John Doe", email: "user@company.com", initials: "JD" } },
    accountId: "user@company.com",
    source_doc: "developer.clickup.com/reference/getauthorizeduser",
  },
  "@appstrate/convertkit": {
    authKey: "primary",
    source: {
      user: { email: "creator@example.com", id: 42 },
      account: { id: 7, name: "Creator", plan_type: "creator_pro" },
    },
    accountId: "creator@example.com",
    source_doc: "developers.kit.com/api-reference/accounts/get-current-account (OpenAPI)",
  },
  "@appstrate/discord": {
    authKey: "primary",
    source: {
      id: "80351110224678912",
      username: "Nelly",
      discriminator: "1337",
      global_name: "Nelly",
    },
    accountId: "80351110224678912",
    source_doc: "docs.discord.com/developers/resources/user",
  },
  "@appstrate/github": {
    authKey: "primary",
    source: {
      login: "octocat",
      id: 1,
      name: "The Octocat",
      email: "octocat@github.com",
      avatar_url: "https://avatars/u/1",
    },
    accountId: "octocat",
    source_doc: "docs.github.com/rest/users/users#get-the-authenticated-user",
  },
  "@appstrate/github-git": {
    authKey: "oauth",
    source: {
      login: "octocat",
      id: 1,
      name: "The Octocat",
      email: "octocat@github.com",
      avatar_url: "https://avatars/u/1",
    },
    accountId: "octocat",
    source_doc: "docs.github.com/rest/users/users#get-the-authenticated-user",
  },
  "@appstrate/github-mcp": {
    authKey: "oauth",
    source: {
      login: "octocat",
      id: 1,
      name: "The Octocat",
      email: "octocat@github.com",
      avatar_url: "https://avatars/u/1",
    },
    accountId: "octocat",
    source_doc: "docs.github.com/rest/users/users#get-the-authenticated-user",
  },
  "@appstrate/gmail": {
    authKey: "primary",
    source: {
      sub: "10769150350006150715113082367",
      email: "user@gmail.com",
      name: "User",
      picture: "https://lh3/a",
    },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration",
  },
  "@appstrate/gmail-mcp": {
    authKey: "primary",
    source: {
      sub: "10769150350006150715113082367",
      email: "user@gmail.com",
      name: "User",
      picture: "https://lh3/a",
    },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration",
  },
  // The five Google integrations below carry no `userinfo_endpoint`: they
  // request the `openid`+`email` scopes, so the claims arrive in the
  // `id_token` the token response already contains and no extra call is made.
  "@appstrate/google-calendar": {
    authKey: "primary",
    source: { sub: "1076915035000615071", email: "user@gmail.com", name: "User" },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration (id_token claims)",
  },
  "@appstrate/google-contacts": {
    authKey: "primary",
    source: { sub: "1076915035000615071", email: "user@gmail.com", name: "User" },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration (id_token claims)",
  },
  "@appstrate/google-drive": {
    authKey: "primary",
    source: { sub: "1076915035000615071", email: "user@gmail.com", name: "User" },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration (id_token claims)",
  },
  "@appstrate/google-forms": {
    authKey: "primary",
    source: { sub: "1076915035000615071", email: "user@gmail.com", name: "User" },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration (id_token claims)",
  },
  "@appstrate/google-sheets": {
    authKey: "primary",
    source: { sub: "1076915035000615071", email: "user@gmail.com", name: "User" },
    accountId: "user@gmail.com",
    source_doc: "accounts.google.com/.well-known/openid-configuration (id_token claims)",
  },
  "@appstrate/intercom": {
    authKey: "primary",
    source: { type: "admin", id: "2001", email: "wash@serenity.io", name: "Hoban Washburn" },
    accountId: "wash@serenity.io",
    source_doc: "developers.intercom.com — GET https://api.intercom.io/me",
  },
  "@appstrate/linkedin": {
    authKey: "primary",
    source: {
      sub: "782bbtaQ",
      name: "John Doe",
      email: "doe@email.com",
      email_verified: true,
      picture: "https://media/x",
    },
    accountId: "doe@email.com",
    source_doc: "learn.microsoft.com/linkedin — sign-in-with-linkedin-v2",
  },
  "@appstrate/microsoft-outlook": {
    authKey: "primary",
    source: {
      id: "87d349ed-44d7-43e1-9a83-5f2406dee5bd",
      displayName: "Adele Vance",
      mail: "AdeleV@contoso.com",
      userPrincipalName: "AdeleV@contoso.com",
    },
    accountId: "AdeleV@contoso.com",
    source_doc: "learn.microsoft.com/graph/api/user-get",
  },
  "@appstrate/microsoft-teams": {
    authKey: "primary",
    source: {
      id: "87d349ed-44d7-43e1-9a83-5f2406dee5bd",
      displayName: "Adele Vance",
      mail: "AdeleV@contoso.com",
      userPrincipalName: "AdeleV@contoso.com",
    },
    accountId: "AdeleV@contoso.com",
    source_doc: "learn.microsoft.com/graph/api/user-get",
  },
  "@appstrate/onedrive": {
    authKey: "primary",
    source: {
      id: "87d349ed-44d7-43e1-9a83-5f2406dee5bd",
      displayName: "Adele Vance",
      mail: "AdeleV@contoso.com",
      userPrincipalName: "AdeleV@contoso.com",
    },
    accountId: "AdeleV@contoso.com",
    source_doc: "learn.microsoft.com/graph/api/user-get",
  },
  "@appstrate/paypal": {
    authKey: "primary",
    source: {
      user_id: "https://www.paypal.com/webapps/auth/identity/user/abc",
      name: "John Doe",
      email: "jdoe@example.com",
    },
    accountId: "jdoe@example.com",
    source_doc:
      "paypalobjects.com/.well-known/openid-configuration + developer.paypal.com identity API",
  },
  "@appstrate/pinterest": {
    authKey: "primary",
    source: {
      account_type: "BUSINESS",
      id: "123456789",
      username: "myusername",
      website_url: "https://example.com",
    },
    accountId: "myusername",
    source_doc: "developers.pinterest.com — GET /v5/user_account",
  },
  "@appstrate/pipedrive": {
    authKey: "primary",
    source: {
      success: true,
      data: { id: 1337, name: "Jane", email: "jane@company.com", company_id: 42 },
    },
    accountId: "jane@company.com",
    source_doc: "developers.pipedrive.com/docs/api/v1/Users#getCurrentUser",
  },
  "@appstrate/reddit": {
    authKey: "primary",
    source: { id: "1w72", name: "spez", is_employee: true },
    accountId: "spez",
    source_doc: "reddit.com/dev/api/oauth — GET /api/v1/me",
  },
  "@appstrate/typeform": {
    authKey: "primary",
    source: { alias: "Batman", email: "bruce@wayne.com", language: "en" },
    accountId: "bruce@wayne.com",
    source_doc: "typeform.com/developers — GET https://api.typeform.com/me",
  },
  // Wrike answers with a single-element array. `readPath` walks the numeric
  // index because a JS array is an object keyed by its indices — pinned here
  // so that property is never refactored away silently.
  "@appstrate/wrike": {
    authKey: "primary",
    source: {
      kind: "contacts",
      data: [{ id: "KUAFY3BJ", primaryEmail: "user@company.com", firstName: "User" }],
    },
    accountId: "user@company.com",
    source_doc: "developers.wrike.com/api/v4/contacts — ?me=true",
  },
  "@appstrate/x": {
    authKey: "primary",
    source: { data: { id: "2244994945", name: "X Dev", username: "XDevelopers" } },
    accountId: "XDevelopers",
    source_doc: "docs.x.com/x-api/users/get-my-user",
  },
  "@appstrate/xero": {
    authKey: "primary",
    source: { sub: "e4f3b1c2", email: "user@company.com", given_name: "User", name: "User Name" },
    accountId: "user@company.com",
    source_doc: "identity.xero.com/.well-known/openid-configuration",
  },
  "@appstrate/zoom": {
    authKey: "primary",
    source: {
      id: "KDcuGIm1QgePTO8WbOqwIQ",
      email: "user@company.com",
      display_name: "User",
      first_name: "User",
    },
    accountId: "user@company.com",
    source_doc: "developers.zoom.us/docs/api/users — GET /users/me",
  },
};

/** Every shipped package that declares `identity_claims`, keyed by packageId. */
async function loadDeclaring(): Promise<
  Map<string, { manifest: IntegrationManifest; authKeys: string[] }>
> {
  const { packages, warnings } = await loadSystemPackages(ARCHIVE_DIR);
  expect(warnings).toEqual([]);
  const out = new Map<string, { manifest: IntegrationManifest; authKeys: string[] }>();
  for (const entry of packages) {
    const auths = (entry.manifest as { auths?: Record<string, unknown> }).auths;
    if (!auths) continue;
    const authKeys = Object.entries(auths)
      .filter(([, a]) => {
        const claims = (a as { identity_claims?: unknown }).identity_claims;
        return !!claims && typeof claims === "object" && Object.keys(claims).length > 0;
      })
      .map(([k]) => k);
    if (authKeys.length > 0) {
      out.set(entry.packageId, {
        manifest: entry.manifest as unknown as IntegrationManifest,
        authKeys,
      });
    }
  }
  return out;
}

describe("system-package identity_claims → accountId", () => {
  it("resolves the documented account key for every declaring package", async () => {
    const declaring = await loadDeclaring();
    const failures: string[] = [];
    for (const [packageId, testCase] of Object.entries(CASES)) {
      const pkg = declaring.get(packageId);
      if (!pkg) continue; // coverage gate below reports this
      const { accountId } = extractIdentity(pkg.manifest, testCase.authKey, testCase.source);
      if (accountId !== testCase.accountId) {
        failures.push(
          `${packageId}: expected accountId '${testCase.accountId}', got '${accountId}' (payload per ${testCase.source_doc})`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  // "default" is the sentinel that means "no identity resolved" — it collapses
  // every connection on a provider onto one indistinguishable key and produces
  // the "Connexion N" label. A declared mapping that still lands there is a
  // broken accessor, which is the exact failure this file exists to catch.
  it("never falls back to the 'default' sentinel for a declared mapping", async () => {
    const declaring = await loadDeclaring();
    const fellBack: string[] = [];
    for (const [packageId, testCase] of Object.entries(CASES)) {
      const pkg = declaring.get(packageId);
      if (!pkg) continue;
      const { accountId } = extractIdentity(pkg.manifest, testCase.authKey, testCase.source);
      if (accountId === "default") fellBack.push(packageId);
    }
    expect(fellBack).toEqual([]);
  });

  it("populates the declared side-claims, not just the account key", async () => {
    const declaring = await loadDeclaring();
    const empty: string[] = [];
    for (const [packageId, testCase] of Object.entries(CASES)) {
      const pkg = declaring.get(packageId);
      if (!pkg) continue;
      const { identityClaims } = extractIdentity(pkg.manifest, testCase.authKey, testCase.source);
      // `sub` is declared by every mapping in this repo and is the claim
      // `required_identity_claims` most often names, so an empty one would
      // make that gate reject the connection outright.
      if (identityClaims.sub === undefined || identityClaims.sub === "") empty.push(packageId);
    }
    expect(empty).toEqual([]);
  });

  it("has a fixture for every shipped package that declares identity_claims", async () => {
    const declaring = await loadDeclaring();
    const uncovered = [...declaring.keys()].filter((id) => !(id in CASES)).sort();
    expect(uncovered).toEqual([]);
  });

  it("has no fixture for a package that no longer declares identity_claims", async () => {
    const declaring = await loadDeclaring();
    const stale = Object.keys(CASES)
      .filter((id) => !declaring.has(id))
      .sort();
    expect(stale).toEqual([]);
  });

  it("exercises the auth key the fixture names", async () => {
    const declaring = await loadDeclaring();
    const wrongKey: string[] = [];
    for (const [packageId, testCase] of Object.entries(CASES)) {
      const pkg = declaring.get(packageId);
      if (!pkg) continue;
      if (!pkg.authKeys.includes(testCase.authKey)) {
        wrongKey.push(
          `${packageId}: fixture targets '${testCase.authKey}', declared: [${pkg.authKeys.join(", ")}]`,
        );
      }
    }
    expect(wrongKey).toEqual([]);
  });
});
