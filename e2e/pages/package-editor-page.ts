// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The query parameter naming a detail page's settings section, and the hash of the tab holding
 * it, per route segment (`apps/web/src/lib/settings-section-href.ts`).
 */
const SETTINGS_ADDRESS: Record<string, [param: string, tab: string]> = {
  agents: ["agentSettings", "settings"],
  skills: ["packageSettings", "settings"],
  "mcp-servers": ["packageSettings", "settings"],
  integrations: ["integrationSettings", "configuration"],
};

/**
 * Page Object for the saved package file editor: edits stay staged until Save.
 *
 * The surface carries no test ids: it is driven the way an author drives it —
 * the tab by its label, the tree by its ARIA role, the row gestures by the
 * accessible names of the two buttons a row shows. That is deliberate, because
 * those names are the contract a screen reader reads too.
 *
 * Tree rows show a file's LEAF name, not its path (`scripts/run.py` is a
 * `scripts` row with a `run.py` row under it), so `fileRow` matches on the leaf.
 */
export class PackageEditorPage {
  constructor(
    private page: Page,
    private scope: string,
    private name: string,
    private type = "skills",
  ) {}

  /** The saved package's Paramètres › Fichiers address. */
  get settingsUrl(): string {
    const [param, tab] = SETTINGS_ADDRESS[this.type]!;
    return `/${this.type}/${this.scope}/${this.name}?${param}=files#${tab}`;
  }

  /** Open the saved package's Paramètres › Fichiers section and wait for the tree to render. */
  async goto() {
    await this.page.goto(this.settingsUrl);
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

  /** The form dialog currently open (new file, rename). */
  get dialog(): Locator {
    return this.page.getByRole("dialog");
  }

  /**
   * The confirmation currently open (deleting a file, leaving with staged changes): an alert
   * dialog, which ARIA names apart from `dialog` and which an outside click does not dismiss.
   */
  get confirmDialog(): Locator {
    return this.page.getByRole("alertdialog");
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

  /** Rename through the row's *Renommer* button. Staged until Save. */
  async renameFile(from: string, to: string) {
    await this.fileRow(from).getByRole("button", { name: "Renommer" }).click();
    const input = this.dialog.getByLabel("Chemin du fichier");
    await input.fill(to);
    await this.dialog.getByRole("button", { name: "Renommer" }).click();
    await expect(this.dialog).toHaveCount(0);
  }

  /** Delete through the row's *Supprimer* button and confirm. Staged until Save. */
  async deleteFile(path: string) {
    await this.fileRow(path).getByRole("button", { name: "Supprimer" }).click();
    await this.confirmDialog.getByRole("button", { name: "Supprimer" }).click();
    await expect(this.confirmDialog).toHaveCount(0);
  }

  /** Select `path` in the tree and open one item of its « Actions » menu (detail page). */
  async fileAction(path: string, item: string) {
    await this.fileRow(path).click();
    // The selected file's pane: its header over the preview the tree controls
    // (`aria-controls`). The page header carries an « Actions » menu of its own.
    const pane = this.page.locator("div:has(> #agent-file-preview)");
    await pane.getByRole("button", { name: "Actions", exact: true }).click();
    await this.page.getByRole("menuitem", { name: item, exact: true }).click();
  }

  /**
   * Detail page: open `path` through « Actions › Modifier », replace its text with `text`, and
   * apply it. Staged until Save.
   */
  async editFile(path: string, text: string) {
    await this.fileAction(path, "Modifier");
    const modal = this.page.getByRole("dialog", { name: `Modifier ${path}` });
    await this.replaceEditorText(modal, text);
    await modal.getByRole("button", { name: "Appliquer", exact: true }).click();
    await expect(modal).toHaveCount(0);
  }

  /**
   * Replace the text of the Monaco editor inside `scope` with `text`, and wait
   * until it shows it.
   *
   * Monaco owns its own input surface, so text reaches it through the focused
   * editor rather than a `fill`: one `insertText` once it holds focus, since
   * per-key `type` events are dropped by Monaco in Chromium on macOS. An editor
   * that has just mounted can still swallow the insertion, so it is retried
   * until the text is shown — over a selection of everything, so a retry never
   * doubles what an earlier attempt inserted.
   */
  private async replaceEditorText(scope: Locator, text: string) {
    const lines = scope.locator(".monaco-editor .view-lines");
    await expect(lines).toBeVisible();
    const firstLine = text.split("\n")[0]!;
    await expect(async () => {
      await lines.click();
      await expect(scope.locator(".monaco-editor.focused")).toBeVisible();
      await this.page.keyboard.press("ControlOrMeta+A");
      await this.page.keyboard.insertText(text);
      await expect(lines).toContainText(firstLine, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }
}
