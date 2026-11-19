// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createOverviewContext } from "../../helpers/overview.ts";
import { createSpace } from "../../helpers/seed.ts";
import { Sidebar } from "../../pages/sidebar.ts";
import type { FileDto } from "../../../apps/web/src/hooks/use-files.ts";

// Controlled file responses exercise gallery layout and capability gates without an LLM run.
function file(id: string, name: string, spaceId: string): FileDto {
  return {
    object: "file",
    id,
    uri: `appfile://${id}`,
    name,
    spaceId,
    purpose: "user_upload",
    runId: null,
    chat_session_id: null,
    packageId: null,
    mime: "image/png",
    size: 68,
    downloadable: true,
    previewable: true,
    preview_kind: "image",
    createdAt: "2026-10-16T10:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    capabilities: {
      visible: true,
      metadata: true,
      preview: true,
      download: true,
      keep: true,
      delete: true,
    },
  };
}

for (const appearance of [
  { width: 1440, colorScheme: "light" },
  { width: 390, colorScheme: "dark" },
] as const) {
  test(`file grid and saved table choice at ${appearance.width}px ${appearance.colorScheme}`, async ({
    authedPage: page,
    browserCtx,
  }, testInfo) => {
    await page.setViewportSize({ width: appearance.width, height: 900 });
    await page.emulateMedia({ colorScheme: appearance.colorScheme });
    const image = file("file_grid", "capture.png", browserCtx.org.defaultSpaceId);
    const opaque = {
      ...file("file_private", "Fichier privé", browserCtx.org.defaultSpaceId),
      capabilities: {
        visible: true,
        metadata: false,
        preview: false,
        download: false,
        keep: false,
        delete: false,
      },
    };
    let deleted = false;
    let kept = false;
    let imageReads = 0;
    let privateReads = 0;
    await page.route(/\/api\/files(?:[/?]|$)/, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/files") {
        const q = url.searchParams.get("q");
        const rows = deleted
          ? [opaque]
          : [{ ...image, expiresAt: kept ? null : image.expiresAt }, opaque];
        return route.fulfill({
          json: {
            object: "list",
            data: q ? rows.filter((row) => row.name.includes(q)) : rows,
            hasMore: false,
          },
        });
      }
      if (url.pathname === "/api/files/file_grid/keep") {
        kept = true;
        return route.fulfill({ json: { ...image, expiresAt: null } });
      }
      if (route.request().method() === "DELETE") {
        deleted = true;
        return route.fulfill({ status: 204 });
      }
      if (url.pathname === "/api/files/file_grid/content") {
        imageReads++;
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      }
      if (url.pathname === "/api/files/file_private/content") privateReads++;
      return route.fulfill({ json: { ...image, preview_url: "/api/files/file_grid/content" } });
    });
    await page.goto("/files");
    const cards = page.getByRole("tab", { name: "Vue cartes", exact: true });
    const table = page.getByRole("tab", { name: "Vue tableau", exact: true });
    await expect(cards).toHaveAttribute("data-state", "active");
    const preview = page.getByRole("button", { name: "Aperçu: capture.png", exact: true });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Plus d'actions pour Fichier privé", exact: true }),
    ).toHaveCount(0);
    expect(privateReads).toBe(0);
    expect(imageReads).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("files-grid.png"), fullPage: true });

    await preview.click();
    await expect(page.getByRole("dialog", { name: "capture.png", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/preview=file_grid/);
    await page.keyboard.press("Escape");
    await expect(preview).toBeFocused();

    const menu = page.getByRole("button", { name: "Plus d'actions pour capture.png", exact: true });
    await menu.click();
    await page.getByRole("menuitem", { name: "Conserver", exact: true }).click();
    await expect.poll(() => kept).toBe(true);
    await menu.click();
    await expect(page.getByRole("menuitem", { name: "Conserver", exact: true })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Télécharger", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("capture.png");

    await table.click();
    await expect(page.getByRole("table", { name: "Documents", exact: true })).toBeVisible();
    await page.reload();
    await expect(table).toHaveAttribute("data-state", "active");
    await cards.click();
    await page.reload();
    await expect(cards).toHaveAttribute("data-state", "active");
    const search = page.getByRole("textbox", { name: /Rechercher des fichiers/ });
    await search.fill("absent");
    await expect(
      page.getByText("Aucun document ne correspond à ce filtre.", { exact: true }),
    ).toBeVisible();
    await search.fill("");
    await expect(preview).toBeVisible();
    await menu.click();
    await page.getByRole("menuitem", { name: "Supprimer", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.getByRole("button", { name: "Annuler", exact: true }).click();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole("menuitem", { name: "Supprimer", exact: true }).click();
    await confirm.getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect(deleted).toBe(true);
  });
}

for (const view of ["Vue cartes", "Vue tableau"]) {
  test(`gallery drops other spaces' files during a slow scope change in ${view}`, async ({
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    const working = await createSpace(orgOnlyClient, "Gallery A");
    const other = await createSpace(orgOnlyClient, "Gallery B");
    const context = await createOverviewContext(
      browser,
      browserCtx.auth,
      browserCtx.org.orgId,
      working.id,
    );
    const page = await context.newPage();
    const name = "only-in-b.txt";
    const row = {
      ...file("file_scope_b", name, other.id),
      previewable: false,
      preview_kind: "none",
      mime: "text/plain",
    };
    const release = Promise.withResolvers<void>();
    try {
      await page.route(/\/api\/orgs\/[^/]+\/files(?:\?|$)/, (route) =>
        route.fulfill({ json: { object: "list", data: [row], hasMore: false } }),
      );
      await page.route(/\/api\/files(?:\?|$)/, async (route) => {
        await release.promise;
        await route.fulfill({ json: { object: "list", data: [], hasMore: false } });
      });
      await page.goto("/files");
      await page.getByRole("tab", { name: view, exact: true }).click();
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
      const pending = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/files",
      );
      await new Sidebar(page).switchSpace(working.name);
      expect((await pending).headers()["x-space-id"]).toBe(working.id);
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Plus d'actions pour ${name}` })).toHaveCount(
        0,
      );
      release.resolve();
    } finally {
      release.resolve();
      await context.close();
    }
  });
}
