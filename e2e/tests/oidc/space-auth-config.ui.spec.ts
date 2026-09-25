// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space authentication settings (org settings → Espace → Authentification),
 * driven through the form and read back two ways: what the tab re-seeds itself
 * with after a reload, and what the routes put on the wire.
 *
 * Both halves matter because the form keeps camelCase local state
 * (`fromAddress`, `clientId`) while the wire is snake_case (`from_address`,
 * `client_id`). A field the save path names wrongly is dropped by the server's
 * schema or 400s; a field the re-seed path names wrongly comes back EMPTY after
 * a reload even though the row was written — only a reload shows that.
 *
 * The camelCase checks exclude the documented DB-convention carve-out
 * (`spaceId`, `createdAt`, `updatedAt`, see docs/CASING_CONVENTIONS.md).
 *
 * The SMTP "send a test email" action is not exercised: it needs a reachable
 * SMTP server, and against a fake host its outcome depends on the network.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { Locator, Page } from "@playwright/test";

const AUTH_TAB_PATH = "/org-settings/space/auth";
const CAMEL_CASE_CARVE_OUT = new Set(["spaceId", "createdAt", "updatedAt"]);

function camelCaseKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((key) => /[A-Z]/.test(key) && !CAMEL_CASE_CARVE_OUT.has(key));
}

/** One section of the tab, found by its heading (the badge is part of the name). */
function section(page: Page, title: RegExp): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title }) });
}

/**
 * The control under a field label. The tab's `<Label>`s carry no `htmlFor`, so
 * the label is not the control's accessible name — the field is the label's
 * wrapper, and the control lives next to it. A required field's label ends in
 * ` *`, hence the prefix match.
 */
function field(scope: Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.locator("label", { hasText: new RegExp(`^${escaped}( \\*)?$`) }).locator("xpath=..");
}

test.describe("Space authentication settings — UI", () => {
  test("SMTP settings saved from the form survive a reload and travel snake_case", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const spaceId = browserCtx.org.defaultSpaceId;
    const host = `smtp-${Date.now().toString(36)}.example.com`;

    await page.goto(AUTH_TAB_PATH);
    const smtp = section(page, /^Serveur SMTP/);
    await expect(smtp.getByText("Non configuré")).toBeVisible();

    await field(smtp, "Hôte").locator("input").fill(host);
    await field(smtp, "Port").locator("input").fill("2525");
    await field(smtp, "Nom d'utilisateur").locator("input").fill("mailer");
    await field(smtp, "Mot de passe").locator("input").fill("s3cret-pass");
    await field(smtp, "Adresse d'expéditeur").locator("input").fill("noreply@tenant.example.com");
    await field(smtp, "Nom d'expéditeur").locator("input").fill("Acme Tenant");
    await field(smtp, "Mode de chiffrement").getByRole("combobox").click();
    await page.getByRole("option", { name: "STARTTLS", exact: true }).click();
    await expect(field(smtp, "Mode de chiffrement").getByRole("combobox")).toContainText(
      "STARTTLS",
    );

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/spaces/${spaceId}/smtp-config`,
    );
    await smtp.getByRole("button", { name: "Enregistrer" }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    // The body the SPA sent: snake_case, and every field the form collected.
    expect(response.request().postDataJSON()).toEqual({
      host,
      port: 2525,
      username: "mailer",
      pass: "s3cret-pass",
      from_address: "noreply@tenant.example.com",
      from_name: "Acme Tenant",
      secure_mode: "starttls",
    });
    await expect(page.getByText("Configuration SMTP enregistrée")).toBeVisible();

    // After a reload the form is seeded from the GET alone.
    await page.reload();
    await expect(smtp.getByText("Configuré", { exact: true })).toBeVisible();
    await expect(field(smtp, "Hôte").locator("input")).toHaveValue(host);
    await expect(field(smtp, "Port").locator("input")).toHaveValue("2525");
    await expect(field(smtp, "Nom d'utilisateur").locator("input")).toHaveValue("mailer");
    await expect(field(smtp, "Adresse d'expéditeur").locator("input")).toHaveValue(
      "noreply@tenant.example.com",
    );
    await expect(field(smtp, "Nom d'expéditeur").locator("input")).toHaveValue("Acme Tenant");
    await expect(field(smtp, "Mode de chiffrement").getByRole("combobox")).toContainText(
      "STARTTLS",
    );
    // Write-only: the stored password is never sent back to fill the field.
    await expect(field(smtp, "Mot de passe").locator("input")).toHaveValue("");

    const res = await apiClient.get(`/spaces/${spaceId}/smtp-config`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      spaceId,
      host,
      port: 2525,
      username: "mailer",
      from_address: "noreply@tenant.example.com",
      from_name: "Acme Tenant",
      secure_mode: "starttls",
    });
    expect(camelCaseKeys(body)).toEqual([]);
    expect(body).not.toHaveProperty("pass");
  });

  test("a social provider saved from the form survives a reload and never returns its secret", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const spaceId = browserCtx.org.defaultSpaceId;
    const clientId = `e2e-${Date.now().toString(36)}.apps.googleusercontent.com`;
    const clientSecret = "e2e-google-client-secret";

    await page.goto(AUTH_TAB_PATH);
    const google = section(page, /^Google Sign-In/);
    await expect(google.getByText("Non configuré")).toBeVisible();

    await field(google, "Client ID").locator("input").fill(clientId);
    await field(google, "Client Secret").locator("input").fill(clientSecret);
    await field(google, "Scopes (optionnel)").locator("input").fill("openid email profile");

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/spaces/${spaceId}/social-providers/google`,
    );
    await google.getByRole("button", { name: "Enregistrer" }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      scopes: ["openid", "email", "profile"],
    });
    const savedBody = (await response.json()) as Record<string, unknown>;
    expect(savedBody).not.toHaveProperty("client_secret");
    expect(camelCaseKeys(savedBody)).toEqual([]);

    await page.reload();
    await expect(google.getByText("Configuré", { exact: true })).toBeVisible();
    await expect(field(google, "Client ID").locator("input")).toHaveValue(clientId);
    await expect(field(google, "Scopes (optionnel)").locator("input")).toHaveValue(
      "openid email profile",
    );
    await expect(field(google, "Client Secret").locator("input")).toHaveValue("");
    // The other provider shares the tab, not the row.
    await expect(section(page, /^GitHub Sign-In/).getByText("Non configuré")).toBeVisible();

    const res = await apiClient.get(`/spaces/${spaceId}/social-providers/google`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      spaceId,
      provider: "google",
      client_id: clientId,
      scopes: ["openid", "email", "profile"],
    });
    expect(camelCaseKeys(body)).toEqual([]);
    expect(body).not.toHaveProperty("client_secret");
    expect(JSON.stringify(body)).not.toContain(clientSecret);
  });
});
