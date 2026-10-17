// SPDX-License-Identifier: Apache-2.0

/**
 * The file reader page (`/files/:fileId?org=…&space=…`) (#2056).
 *
 * Files are not creatable through a public endpoint (they come from agent runs and chat uploads),
 * so, like `grid.ui.spec.ts`, the file routes are answered by `context.route`. The
 * not-a-member case needs no stub: a file id that nobody can read is refused by the real server.
 * Mocks are installed on the browser CONTEXT, since the reader opened by "Ouvrir dans un nouvel
 * onglet" lives in a second page.
 */

import type { BrowserContext } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { registerUser, createOrg, createSpace } from "../../helpers/seed.ts";
import { Sidebar } from "../../pages/sidebar.ts";
import type { FileDto } from "../../../apps/web/src/hooks/use-files.ts";

type StubFile = FileDto & { preview_url?: string };

function file(
  id: string,
  name: string,
  spaceId: string,
  mime: string,
  previewKind: FileDto["preview_kind"],
): StubFile {
  return {
    object: "file",
    id,
    uri: `appfile://${id}`,
    name,
    spaceId,
    purpose: "agent_output",
    runId: null,
    chat_session_id: null,
    packageId: null,
    mime,
    size: 120,
    downloadable: true,
    previewable: true,
    preview_kind: previewKind,
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

const HTML_BODY = `<!doctype html><html><head><title>Rapport</title></head><body><h1 id="hello">Bonjour depuis le rapport</h1></body></html>`;

interface StubOptions {
  files: StubFile[];
  /** Receives the `X-Space-Id` header of every single-file read. */
  onFileRead?: (id: string, spaceId: string | undefined) => void;
}

async function stubFiles(context: BrowserContext, opts: StubOptions) {
  await context.route(/\/preview\/files\/[^/?]+/, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: HTML_BODY }),
  );
  await context.route(/\/api\/files(?:[/?]|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/files") {
      return route.fulfill({ json: { object: "list", data: opts.files, hasMore: false } });
    }
    const [, , , id, sub] = url.pathname.split("/");
    const found = opts.files.find((f) => f.id === id);
    if (!found) return route.fulfill({ status: 404, json: { code: "not_found" } });
    if (sub === undefined) {
      opts.onFileRead?.(id!, route.request().headers()["x-space-id"]);
      return route.fulfill({ json: { ...found, preview_url: `/preview/files/${id}?token=e2e` } });
    }
    return route.fulfill({ status: 404, json: { code: "not_found" } });
  });
}

test.describe("file reader page", () => {
  test("renders HTML in the sandboxed iframe and opens from the preview modal in a new tab", async ({
    authedPage: page,
    browserCtx,
  }) => {
    const { orgId, defaultSpaceId } = browserCtx.org;
    const html = file("file_html", "rapport.html", defaultSpaceId, "text/html", "html");
    await stubFiles(page.context(), { files: [html] });

    // Reader page: the iframe is isolated and its body is the RENDERED page.
    await page.goto(`/files/file_html?org=${orgId}&space=${defaultSpaceId}`);
    await expect(page.getByText("Ce contenu s'exécute dans un cadre isolé.")).toBeVisible();
    const frame = page.locator("iframe[title]").first();
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const body = page.frameLocator("iframe[sandbox]").locator("body");
    await expect(body.locator("#hello")).toHaveText("Bonjour depuis le rapport");
    await expect(body).not.toContainText("<html>");
    // The new-tab action is hidden on the reader itself.
    await expect(page.getByRole("button", { name: "Ouvrir dans un nouvel onglet" })).toHaveCount(0);

    // Preview modal over the Files page: the action opens the reader in a new page.
    await page.goto("/files?preview=file_html");
    const dialog = page.getByRole("dialog", { name: "rapport.html", exact: true });
    await expect(dialog).toBeVisible();
    const popupPromise = page.context().waitForEvent("page");
    await dialog.getByRole("button", { name: "Ouvrir dans un nouvel onglet" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    const popupUrl = new URL(popup.url());
    expect(popupUrl.pathname).toBe("/files/file_html");
    expect(popupUrl.searchParams.get("org")).toBe(orgId);
    expect(popupUrl.searchParams.get("space")).toBe(defaultSpaceId);
    await expect(popup.frameLocator("iframe[sandbox]").locator("#hello")).toHaveText(
      "Bonjour depuis le rapport",
    );
  });

  test("a link to a file of another space opens without changing the current space", async ({
    authedPage: page,
    browserCtx,
    apiClient,
  }) => {
    const { orgId, defaultSpaceId } = browserCtx.org;
    const other = await createSpace(apiClient, "Autre espace");
    const reads: Array<string | undefined> = [];
    await stubFiles(page.context(), {
      files: [file("file_other", "autre.html", other.id, "text/html", "html")],
      onFileRead: (_id, spaceId) => reads.push(spaceId),
    });

    await page.goto("/files");
    const sidebar = new Sidebar(page);
    await expect(sidebar.switcherButton).toBeVisible();
    const switcherBefore = (await sidebar.switcherButton.textContent()) ?? "";
    const stores = () =>
      page.evaluate(() => ({
        org: localStorage.getItem("appstrate_current_org"),
        space: localStorage.getItem("appstrate_last_space"),
      }));
    const before = await stores();

    await page.goto(`/files/file_other?org=${orgId}&space=${other.id}`);
    await expect(page.getByText("autre.html", { exact: true }).first()).toBeVisible();
    await expect(page.frameLocator("iframe[sandbox]").locator("#hello")).toBeVisible();

    // The read was made in the LINK's space, and nothing about the current one moved.
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([other.id]));
    expect(await stores()).toEqual(before);
    expect(JSON.parse(before.space ?? "{}")).toEqual(
      expect.objectContaining({
        [`${browserCtx.auth.userId}:${orgId}`]: defaultSpaceId,
      }),
    );
    await expect(sidebar.switcherButton).toHaveText(switcherBefore);
  });

  test("a non-member sees « Fichier introuvable ou inaccessible »", async ({
    browser,
    request,
    browserCtx,
  }) => {
    // No stub: the real server refuses a caller who belongs to neither the org nor the space.
    const outsider = await registerUser(request, { name: "Outsider" });
    const outsiderOrg = await createOrg(request, outsider.cookie);
    const context = await createAuthedContext(
      browser,
      outsider,
      outsiderOrg.orgId,
      outsiderOrg.defaultSpaceId,
    );
    try {
      const page = await context.newPage();
      await page.goto(
        `/files/file_nobody?org=${browserCtx.org.orgId}&space=${browserCtx.org.defaultSpaceId}`,
      );
      await expect(page.getByText("Fichier introuvable ou inaccessible")).toBeVisible();
      await expect(page.locator("iframe")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
