// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Page Object for the skill editor's *Fichiers* tab (`/skills/:scope/:name/edit`).
 *
 * The surface carries no test ids: it is driven the way an author drives it —
 * the tab by its label, the tree by its ARIA role, the row gestures by the
 * accessible names of the two buttons a row shows. That is deliberate, because
 * those names are the contract a screen reader reads too.
 *
 * Tree rows show a file's LEAF name, not its path (`scripts/run.py` is a
 * `scripts` row with a `run.py` row under it), so `fileRow` matches on the leaf.
 */
export class SkillEditorPage {
  constructor(
    private page: Page,
    private scope: string,
    private name: string,
  ) {}

  async goto() {
    await this.page.goto(`/skills/${this.scope}/${this.name}/edit`);
  }

  /** Open *Fichiers* and wait for the tree to render. */
  async openFilesTab() {
    await this.page.getByRole("tab", { name: "Fichiers" }).click();
    await expect(this.tree).toBeVisible();
  }

  get tree(): Locator {
    return this.page.getByRole("tree", { name: "Fichiers du package" });
  }

  /** The row for a file, matched on the leaf name the tree renders. */
  fileRow(path: string): Locator {
    const leaf = path.split("/").at(-1)!;
    return this.tree.getByRole("treeitem").filter({ hasText: leaf });
  }

  /** The dialog currently open, whichever gesture opened it. */
  get dialog(): Locator {
    return this.page.getByRole("dialog");
  }

  get saveButton(): Locator {
    return this.page.getByRole("button", { name: "Enregistrer", exact: true });
  }

  /** Create an empty file at `path` through *Nouveau fichier*. */
  async createFile(path: string) {
    await this.page.getByRole("button", { name: "Nouveau fichier" }).click();
    await this.dialog.getByLabel("Chemin du fichier").fill(path);
    await this.dialog.getByRole("button", { name: "Créer", exact: true }).click();
  }

  /** Rename through the row's *Renommer* button. Immediate — no save. */
  async renameFile(from: string, to: string) {
    await this.fileRow(from).getByRole("button", { name: "Renommer" }).click();
    const input = this.dialog.getByLabel("Chemin du fichier");
    await input.fill(to);
    await this.dialog.getByRole("button", { name: "Renommer" }).click();
    await expect(this.dialog).toHaveCount(0);
  }

  /** Delete through the row's *Supprimer* button and confirm. Immediate — no save. */
  async deleteFile(path: string) {
    await this.fileRow(path).getByRole("button", { name: "Supprimer" }).click();
    await this.dialog.getByRole("button", { name: "Supprimer" }).click();
    await expect(this.dialog).toHaveCount(0);
  }

  /**
   * Type into the Monaco pane showing `path`.
   *
   * Monaco owns its own hidden textarea, so text reaches it through real key
   * events rather than a `fill`. The pane is a labelled region, which is how
   * this waits for the editor to have switched files before typing into it.
   */
  async typeIntoEditor(path: string, text: string) {
    const pane = this.page.getByRole("region", { name: path });
    await expect(pane).toBeVisible();
    const lines = pane.locator(".monaco-editor .view-lines");
    await expect(lines).toBeVisible();
    await lines.click();
    await this.page.keyboard.type(text);
  }
}
