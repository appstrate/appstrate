// SPDX-License-Identifier: Apache-2.0

/**
 * The skill editor's *Fichiers* tab, driven through the browser against the
 * real `PATCH /api/packages/{scope}/{name}/files`.
 *
 * What these tests are for: the editor's two write rhythms and the guard
 * between them. A STRUCTURAL gesture (create, rename, delete) lands
 * immediately and is checked against the API index, not against the tree the
 * page redrew — a client that only updated its own picture would pass a
 * DOM-only assertion. A TEXT edit is buffered until *Enregistrer*, so the same
 * index is what proves the flush actually happened. And the ETag guard is
 * exercised the only way it can be: by moving the tree under an open editor
 * and requiring a message rather than a silent overwrite.
 *
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";
import type { ApiClient } from "../../helpers/api-client.ts";
import { SkillEditorPage } from "../../pages/skill-editor-page.ts";

/** Lowercase-and-digits: the skill frontmatter `name` rule the API enforces. */
function skillName(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

interface FileEntry {
  path: string;
  size: number;
  media_kind: "text" | "binary";
  inline?: string;
}

/** The draft tree as the API reports it — the authority every assertion uses. */
async function listFiles(client: ApiClient, id: string): Promise<FileEntry[]> {
  const res = await client.get(`/packages/${id}/files`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { entries: FileEntry[] };
  return body.entries;
}

/**
 * Write a file the way a second tab or a script would: `If-Match: *` is the
 * deliberate "overwrite whatever is there" the editor itself refuses to send.
 */
async function writeFileOutOfBand(client: ApiClient, id: string, path: string, text: string) {
  const res = await client.patch(
    `/packages/${id}/files`,
    { operations: [{ op: "write", path, text }] },
    { "If-Match": "*" },
  );
  expect(res.status()).toBe(200);
}

test.describe("Skill files editor", () => {
  test("adds a file, buffers its text until save, and the API index has both", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = skillName("files-add");
    await createSkill(apiClient, scope, name);

    const editor = new SkillEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();

    await editor.createFile("scripts/run.py");
    await expect(editor.fileRow("scripts/run.py")).toBeVisible();

    await editor.typeIntoEditor("scripts/run.py", "print(1)");
    await editor.saveButton.click();
    // A successful save leaves the editor for the package's detail page.
    await expect(page).toHaveURL(`/skills/${scope}/${name}`);

    const entries = await listFiles(apiClient, `${scope}/${name}`);
    const written = entries.find((e) => e.path === "scripts/run.py");
    expect(written).toBeDefined();
    expect(written!.inline).toBe("print(1)");

    // Reopening reads the tree back from the server, not from anything the
    // first page kept.
    await editor.goto();
    await editor.openFilesTab();
    await expect(editor.fileRow("scripts/run.py")).toBeVisible();
  });

  test("renames and deletes a file without a save", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = skillName("files-move");
    const id = `${scope}/${name}`;
    await createSkill(apiClient, scope, name);
    await writeFileOutOfBand(apiClient, id, "scripts/run.py", "print(1)");

    const editor = new SkillEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();
    await expect(editor.fileRow("scripts/run.py")).toBeVisible();

    await editor.renameFile("scripts/run.py", "scripts/main.py");
    await expect(editor.fileRow("scripts/main.py")).toBeVisible();

    // Structural gestures are sent as they happen: the index moved with no
    // click on *Enregistrer*.
    const afterRename = (await listFiles(apiClient, id)).map((e) => e.path);
    expect(afterRename).toContain("scripts/main.py");
    expect(afterRename).not.toContain("scripts/run.py");

    await editor.deleteFile("scripts/main.py");
    await expect(editor.fileRow("scripts/main.py")).toHaveCount(0);

    const afterDelete = (await listFiles(apiClient, id)).map((e) => e.path);
    expect(afterDelete).not.toContain("scripts/main.py");
  });

  test("offers no rename or delete on SKILL.md and manifest.json", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = skillName("files-pinned");
    await createSkill(apiClient, scope, name);
    await writeFileOutOfBand(apiClient, `${scope}/${name}`, "notes.md", "Notes.");

    const editor = new SkillEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();

    // The control: an ordinary file carries both gestures, so their absence
    // below is the pinning and not a selector that matches nothing.
    await expect(editor.fileRow("notes.md").getByRole("button", { name: "Renommer" })).toHaveCount(
      1,
    );
    await expect(editor.fileRow("notes.md").getByRole("button", { name: "Supprimer" })).toHaveCount(
      1,
    );

    for (const pinned of ["SKILL.md", "manifest.json"]) {
      await expect(editor.fileRow(pinned)).toBeVisible();
      await expect(editor.fileRow(pinned).getByRole("button")).toHaveCount(0);
    }
  });

  test("refuses a write composed against a tree that moved, and re-reads it", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = skillName("files-stale");
    const id = `${scope}/${name}`;
    await createSkill(apiClient, scope, name);

    const editor = new SkillEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();
    // The page now holds the ETag of a tree without this file.
    await expect(editor.fileRow("SKILL.md")).toBeVisible();

    await writeFileOutOfBand(apiClient, id, "from-api.md", "Written elsewhere.");

    await editor.createFile("scripts/run.py");

    await expect(
      page.getByText(
        "Le package a été modifié ailleurs. L'arborescence a été rechargée ; les fichiers modifiés des deux côtés sont signalés.",
      ),
    ).toBeVisible();
    // The recovery is the other half of the message: the tree the next attempt
    // composes against is the live one.
    await expect(editor.fileRow("from-api.md")).toBeVisible();
    await expect(editor.fileRow("scripts/run.py")).toHaveCount(0);
  });

  test("marks a file the 412 recovery re-read under an open buffer, and saves it anyway", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    // The failure this guards: the author types on tree E1, a colleague writes
    // E2, a structural gesture 412s and the recovery adopts E2's validator — so
    // the next *Enregistrer* would carry E1-based text under an E2 validator and
    // the route would accept it. The overwrite is allowed; being told is not.
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = skillName("files-conflict");
    const id = `${scope}/${name}`;
    await createSkill(apiClient, scope, name);
    await writeFileOutOfBand(apiClient, id, "notes.md", "Original.");

    const editor = new SkillEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();
    await editor.fileRow("notes.md").click();
    await editor.typeIntoEditor("notes.md", "Mine.");

    // A colleague rewrites the same file. The page learns it only when its next
    // structural gesture is refused.
    await writeFileOutOfBand(apiClient, id, "notes.md", "Theirs.");
    await editor.createFile("scripts/run.py");

    await expect(
      page.getByText(
        "Ce fichier a été modifié ailleurs pendant votre édition. Votre version est affichée ; Enregistrer l'écrira par-dessus.",
      ),
    ).toBeVisible();
    await expect(
      editor.fileRow("notes.md").getByRole("img", {
        name: "Modifié ailleurs pendant votre édition",
      }),
    ).toBeVisible();

    // Saving is still the author's call, and it writes THEIR text — over the
    // colleague's, deliberately and after being told.
    await editor.saveButton.click();
    await expect(page).toHaveURL(`/skills/${scope}/${name}`);
    const entries = await listFiles(apiClient, id);
    expect(entries.find((e) => e.path === "notes.md")!.inline).toContain("Mine.");
  });

  test("blocks leaving the page while a file edit is still buffered", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const name = skillName("files-dirty");
    await createSkill(apiClient, scope, name);

    const editor = new SkillEditorPage(page, scope, name);
    await editor.goto();
    await editor.openFilesTab();

    // `SKILL.md` is the pre-selected file; typing into it buffers, it does not
    // write, so the editor is dirty with nothing on the server.
    await editor.typeIntoEditor("SKILL.md", "x");

    await page.getByRole("link", { name: "Agents" }).click();

    await expect(page.getByRole("dialog")).toContainText("Modifications non enregistrées");
    await expect(page).toHaveURL(`/skills/${scope}/${name}/edit`);
  });
});
