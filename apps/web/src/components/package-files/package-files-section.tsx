// SPDX-License-Identifier: Apache-2.0

/**
 * Package AFPS › Contenu: every file the bundle holds, as one table, for every
 * package type. It reads; it does not edit.
 *
 * The package IS its archive, so its Package AFPS group lists the archive:
 * each file with what it is (manifest, main file, reference, script…) and its
 * size. Changing a file is done in one place, Explorer › Fichiers, where the
 * tree and its gestures are (new file, import, rename, delete, edit). Each row
 * here opens its file there.
 */
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { useModalParam } from "../../hooks/use-modal-param";
import { bundleFileRole, type BundleFileRole } from "../../lib/bundle-file-role";
import { DataTable } from "../data-table";
import { JsonEditor } from "../json-editor";
import { Modal } from "../modal";
import { SettingsHeading } from "../settings/settings-heading";
import { usePackageFileColumns } from "./package-files-columns";
import { usePackageFileIndex } from "./use-package-file-index";

/** The manifest first, then the main file, then the rest by path. */
const ROLE_ORDER: BundleFileRole[] = ["manifest", "main", "documentation", "entry-point"];

export function PackageFilesSection({
  type,
  packageId,
  manifest,
  filesHref,
}: {
  type: PackageType;
  packageId: string;
  /** The stored manifest: where a local server's entry point is. */
  manifest: Record<string, unknown>;
  /** Explorer › Fichiers, opened on that file. */
  filesHref: (path: string) => string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { data, error } = usePackageFileIndex(packageId);
  const columns = usePackageFileColumns(type, manifest);
  const rank = (path: string) => {
    const index = ROLE_ORDER.indexOf(bundleFileRole(type, path, manifest));
    return index === -1 ? ROLE_ORDER.length : index;
  };
  const entries = [...(data?.data ?? [])].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path),
  );

  return (
    <div className="space-y-4 p-6">
      <SettingsHeading
        title={t("editor.tabPackageFiles")}
        description={t("editor.description.packageFiles")}
      />
      <DataTable
        tableId="package-files"
        label={t("editor.tabPackageFiles")}
        columns={columns}
        rows={entries}
        rowKey={(entry) => entry.path}
        rowHref={(entry) => filesHref(entry.path)}
        rowLabel={(entry) => entry.path}
        isLoading={!data && !error}
        failure={error}
      />
      <p className="text-muted-foreground text-xs">{t("editor.bundleFilesHint")}</p>
    </div>
  );
}

/**
 * The AFPS manifest, edited raw: the escape hatch, not a section.
 *
 * Every form of Package AFPS writes into `manifest.json`, but the manifest also
 * holds fields no form covers. Its raw editor is reached like every other file:
 * `manifest.json` in Explorer › Fichiers, Actions › Modifier, which opens this
 * modal (`?editManifest=1`) over Général. What it applies joins the same draft
 * the forms write, saved by their save bar.
 */
export function ManifestEditEntry({
  value,
  schema,
  onApply,
}: {
  value: Record<string, unknown>;
  schema?: { uri: string; schema: object };
  onApply: (value: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation("agents");
  const editing = useModalParam("editManifest");
  if (editing.value === null) return null;
  return (
    <Modal
      open
      onClose={editing.close}
      title={t("editor.editFile", { name: "manifest.json" })}
      className="sm:max-w-5xl"
    >
      <JsonEditor
        value={value}
        schema={schema}
        onApply={(next) => {
          onApply(next);
          editing.close();
        }}
      />
    </Modal>
  );
}
