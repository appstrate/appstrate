// SPDX-License-Identifier: Apache-2.0

/** Shared file editor against the real API. @tags @critical */
import { zipSync } from "fflate";
const encoder = new TextEncoder();
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent, createSkill } from "../../helpers/seed.ts";
import type { ApiClient } from "../../helpers/api-client.ts";
import { PackageEditorPage } from "../../pages/package-editor-page.ts";
import {
  apiIntegrationManifest,
  mcpServerManifest,
} from "../../../apps/api/test/helpers/integration-manifests.ts";

interface FileEntry {
  path: string;
  inline?: string;
}
async function listFiles(client: ApiClient, id: string): Promise<FileEntry[]> {
  const response = await client.get(`/packages/${id}/files`);
  expect(response.status()).toBe(200);
  return (await response.json()).entries;
}
async function writeElsewhere(client: ApiClient, id: string, path: string, text: string) {
  const before = await (await client.get(`/packages/skills/${id}`)).json();
  const response = await client.put(`/packages/skills/${id}`, {
    lock_version: before.lock_version,
    operations: [{ op: "write", path, text }],
  });
  expect(response.status()).toBe(200);
}

for (const type of ["skills", "agents", "integrations", "mcp-servers"]) {
  test(`${type}: stages a file and saves manifest and files in one PUT`, async ({
    authedPage: page,
    apiClient,
    browserCtx,
    request,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = `files-${Date.now()}`;
    const id = `${scope}/${name}`;
    if (type === "skills") await createSkill(apiClient, scope, name);
    else if (type === "agents") await createAgent(apiClient, scope, name);
    else if (type === "integrations") {
      const response = await apiClient.post("/packages/integrations", {
        manifest: apiIntegrationManifest({ name: id, auths: { api_key: { type: "api_key" } } }),
        content: "",
      });
      expect(response.status()).toBe(201);
    } else {
      const zip = zipSync({
        "manifest.json": encoder.encode(JSON.stringify(mcpServerManifest({ name: id }))),
        "main.js": encoder.encode("export {};"),
      });
      const response = await request.post("/api/packages/import", {
        headers: {
          Cookie: browserCtx.auth.cookie,
          "X-Org-Id": browserCtx.org.orgId,
          "X-Space-Id": browserCtx.org.defaultSpaceId,
        },
        multipart: {
          file: { name: "server.afps", mimeType: "application/zip", buffer: Buffer.from(zip) },
        },
      });
      expect(response.status(), await response.text()).toBe(201);
    }
    const editor = new PackageEditorPage(page, scope, name, type);
    await editor.goto();
    await editor.openFilesTab();
    await editor.createFile("scripts/run.py");
    await editor.typeIntoEditor("scripts/run.py", "print(1)");
    expect((await listFiles(apiClient, id)).map((entry) => entry.path)).not.toContain(
      "scripts/run.py",
    );
    const writes: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes(`/api/packages/${type}/`))
        writes.push(request.postDataJSON());
    });
    await editor.saveButton.click();
    await expect(page).toHaveURL(`/${type}/${scope}/${name}`);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      manifest: { name: id },
      operations: [{ op: "write", path: "scripts/run.py", text: "print(1)" }],
    });
    expect(
      (await listFiles(apiClient, id)).find((entry) => entry.path === "scripts/run.py")?.inline,
    ).toBe("print(1)");
  });
}

test("rename, delete and discard leave server files unchanged until Save", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`,
    name = `move-${Date.now()}`,
    id = `${scope}/${name}`;
  await createSkill(apiClient, scope, name);
  await writeElsewhere(apiClient, id, "run.py", "print(1)");
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.openFilesTab();
  await editor.renameFile("run.py", "main.py");
  await editor.deleteFile("main.py");
  expect((await listFiles(apiClient, id)).map((entry) => entry.path)).toContain("run.py");
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(editor.dialog).toContainText("Modifications non enregistrées");
  await editor.dialog.getByRole("button", { name: "Quitter sans enregistrer" }).click();
  await expect(page).toHaveURL("/agents");
  expect((await listFiles(apiClient, id)).map((entry) => entry.path)).toContain("run.py");
  await editor.goto();
  await editor.openFilesTab();
  await editor.renameFile("run.py", "main.py");
  await editor.saveButton.click();
  await expect(page).toHaveURL(`/skills/${id}`);
  expect((await listFiles(apiClient, id)).map((entry) => entry.path)).toContain("main.py");
  expect((await listFiles(apiClient, id)).map((entry) => entry.path)).not.toContain("run.py");
});

test("an in-flight save locks Monaco and structural actions", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`,
    name = `saving-${Date.now()}`,
    id = `${scope}/${name}`;
  await createSkill(apiClient, scope, name);
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.openFilesTab();
  await editor.createFile("notes.txt");
  await editor.typeIntoEditor("notes.txt", "BEFORE");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const captured = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/api/packages/skills/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    received();
    await blocked;
    await route.continue();
  });
  await editor.saveButton.click();
  await captured;
  try {
    const pane = page.getByRole("region", { name: "notes.txt", includeHidden: true });
    await expect(pane.locator("textarea")).toHaveAttribute("readonly", "true");
    await expect(
      page.getByRole("button", { name: "Nouveau fichier", includeHidden: true }),
    ).toBeDisabled();
    await page.keyboard.type("AFTER");
    await expect(pane.locator(".view-lines")).not.toContainText("AFTER");
  } finally {
    release();
  }
  await expect(page).toHaveURL(`/skills/${id}`);
  expect((await listFiles(apiClient, id)).find((entry) => entry.path === "notes.txt")?.inline).toBe(
    "BEFORE",
  );
});

test("a concurrent manifest update refuses repeated saves and preserves the whole local draft", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`,
    name = `conflict-${Date.now()}`,
    id = `${scope}/${name}`;
  await createSkill(apiClient, scope, name);
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.openFilesTab();
  await editor.createFile("notes.txt");
  await editor.typeIntoEditor("notes.txt", "MINE");
  const before = await (await apiClient.get(`/packages/skills/${id}`)).json();
  const changed = await apiClient.put(`/packages/skills/${id}`, {
    manifest: { ...before.manifest, description: "COLLEAGUE" },
    lock_version: before.lock_version,
  });
  expect(changed.status()).toBe(200);
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.status() === 409,
    );
    await editor.saveButton.click();
    await refused;
    await expect(page.getByText(/Vos changements sont conservés/)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "notes.txt" }).locator(".view-lines"),
    ).toContainText("MINE");
  }
  expect((await (await apiClient.get(`/packages/skills/${id}`)).json()).manifest.description).toBe(
    "COLLEAGUE",
  );
  expect((await listFiles(apiClient, id)).map((entry) => entry.path)).not.toContain("notes.txt");
});

test("Save draft in the navigation guard uses the same save", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`,
    name = `guard-${Date.now()}`,
    id = `${scope}/${name}`;
  await createSkill(apiClient, scope, name);
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.openFilesTab();
  await editor.createFile("notes.txt");
  await editor.typeIntoEditor("notes.txt", "Saved via guard");
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await editor.dialog.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await expect(page).toHaveURL("/agents");
  expect((await listFiles(apiClient, id)).find((entry) => entry.path === "notes.txt")?.inline).toBe(
    "Saved via guard",
  );
});

test("required files are protected and new paths reject canonical directory collisions", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`,
    name = `paths-${Date.now()}`,
    id = `${scope}/${name}`;
  await createSkill(apiClient, scope, name);
  await writeElsewhere(apiClient, id, "scripts", "file");
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.openFilesTab();
  for (const path of ["SKILL.md", "manifest.json"])
    await expect(editor.fileRow(path).getByRole("button")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Nouveau fichier" }).click();
  await editor.dialog.getByLabel("Chemin du fichier").fill("Scripts/run.py");
  await expect(editor.dialog).toBeVisible();
  await expect(editor.dialog.getByRole("button", { name: "Créer", exact: true })).toBeDisabled();
  await expect(editor.dialog.getByLabel("Chemin du fichier")).toHaveAccessibleDescription(
    /chemin/i,
  );
});

test("import refuses collisions without losing local edits; Replace remains explicit", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `upload-${Date.now()}`;
  const id = `${scope}/${name}`;
  await createSkill(apiClient, scope, name);
  await writeElsewhere(apiClient, id, "run.py", "SERVER");
  const editor = new PackageEditorPage(page, scope, name);
  await editor.goto();
  await editor.openFilesTab();
  await editor.fileRow("run.py").click();
  const pane = page.getByRole("region", { name: "run.py", exact: true });
  const lines = pane.locator(".monaco-editor .view-lines");
  await lines.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" LOCAL");

  for (const filenames of [
    ["fresh.txt", "run.py"],
    ["fresh.txt", "RUN.py"],
    ["fresh.txt", "fresh.txt"],
  ]) {
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Importer", exact: true }).click();
    await (
      await choosing
    ).setFiles(
      filenames.map((filename) => ({
        name: filename,
        mimeType: "text/plain",
        buffer: Buffer.from("IMPORTED"),
      })),
    );
    await expect(page.getByText(/Pour remplacer un fichier/).first()).toBeVisible();
    await expect(lines).toContainText("SERVER LOCAL");
    await expect(editor.fileRow("fresh.txt")).toHaveCount(0);
    expect((await listFiles(apiClient, id)).find((entry) => entry.path === "run.py")?.inline).toBe(
      "SERVER",
    );
  }

  const choosing = page.waitForEvent("filechooser");
  await pane.getByRole("button", { name: "Remplacer", exact: true }).click();
  await (
    await choosing
  ).setFiles({ name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("REPLACED") });
  await expect(lines).toContainText("REPLACED");
  expect((await listFiles(apiClient, id)).find((entry) => entry.path === "run.py")?.inline).toBe(
    "SERVER",
  );
  await editor.saveButton.click();
  await expect(page).toHaveURL(`/skills/${id}`);
  expect((await listFiles(apiClient, id)).find((entry) => entry.path === "run.py")?.inline).toBe(
    "REPLACED",
  );
});

for (const nonInline of [false, true]) {
  test(`reopening waits for fresh ${nonInline ? "fetched content" : "index"} before seeding Monaco`, async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`,
      name = `cache-${Date.now()}`,
      id = `${scope}/${name}`;
    await createSkill(apiClient, scope, name);
    if (nonInline) await writeElsewhere(apiClient, id, "A.txt", "\n".repeat(1_048_570));
    await writeElsewhere(apiClient, id, "z-notes.txt", "OLD ".repeat(50));
    const indexed = (await listFiles(apiClient, id)).find((entry) => entry.path === "z-notes.txt")!;
    expect(indexed.inline === undefined).toBe(nonInline);
    const editor = new PackageEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();
    await editor.fileRow("z-notes.txt").click();
    const lines = page.getByRole("region", { name: "z-notes.txt" }).locator(".view-lines");
    await expect(lines).toContainText("OLD");
    await lines.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("NEW ".repeat(50));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/packages/**/files**", async (route) => {
      await blocked;
      await route.continue().catch(() => {});
    });
    await editor.saveButton.click();
    await expect(page).toHaveURL(`/skills/${id}`);
    await page.getByRole("button", { name: "Actions du package" }).click();
    await page.getByRole("menuitem", { name: "Modifier", exact: true }).click();
    await page.getByRole("tab", { name: "Fichiers", exact: true }).click();
    try {
      await expect(editor.tree).not.toBeVisible();
    } finally {
      release();
    }
    await expect(editor.tree).toBeVisible();
    await editor.fileRow("z-notes.txt").click();
    await expect(lines).toContainText("NEW");
    await expect(lines).not.toContainText("OLD");
  });
}
