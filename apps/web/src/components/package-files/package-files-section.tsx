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
import { Link } from "react-router-dom";
import { Braces, FolderOpen } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { formatBytes } from "@appstrate/core/format";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { $api } from "../../api/client";
import { useModalParam } from "../../hooks/use-modal-param";
import { useOrgScope } from "../../hooks/use-org-scope";
import { bundleFileRole, type BundleFileRole } from "../../lib/bundle-file-role";
import { splitPackageRef } from "../../lib/package-paths";
import { JsonEditor } from "../json-editor";
import { Modal } from "../modal";
import { LoadingState } from "../page-states";
import { SettingsHeading } from "../settings/settings-heading";
import { TableRowActions } from "../table-row-actions";

const ROLE_LABEL: Record<BundleFileRole, string> = {
  manifest: "editor.fileRole.manifest",
  main: "editor.fileRole.main",
  documentation: "editor.fileRole.documentation",
  "entry-point": "editor.fileRole.entryPoint",
  reference: "editor.fileRole.reference",
  script: "editor.fileRole.script",
  asset: "editor.fileRole.asset",
  other: "editor.fileRole.other",
};

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
  const scope = useOrgScope();
  const { data } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    { params: { path: splitPackageRef(packageId), header: scope.header } },
    { enabled: scope.enabled },
  );
  const rank = (path: string) => {
    const index = ROLE_ORDER.indexOf(bundleFileRole(type, path, manifest));
    return index === -1 ? ROLE_ORDER.length : index;
  };
  const entries = [...(data?.entries ?? [])].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path),
  );

  return (
    <div className="space-y-4 p-6">
      <SettingsHeading
        title={t("editor.tabPackageFiles")}
        description={t("editor.description.packageFiles")}
      />
      {!data ? (
        <LoadingState />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("editor.bundleFileColumn")}</TableHead>
                <TableHead className="w-44">{t("editor.bundleTypeColumn")}</TableHead>
                <TableHead className="w-24 text-right">{t("editor.bundleSizeColumn")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.path}>
                  <TableCell className="text-sm">{entry.path}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {t(ROLE_LABEL[bundleFileRole(type, entry.path, manifest)])}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                    {formatBytes(entry.size)}
                  </TableCell>
                  <TableCell>
                    <TableRowActions menuLabel={t("editor.rowActions", { name: entry.path })}>
                      <DropdownMenuItem asChild>
                        <Link to={filesHref(entry.path)}>
                          <FolderOpen />
                          {t("editor.viewInExplorer")}
                        </Link>
                      </DropdownMenuItem>
                    </TableRowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-muted-foreground text-xs">{t("editor.bundleFilesHint")}</p>
    </div>
  );
}

/**
 * The AFPS manifest, edited raw: the escape hatch, not a section.
 *
 * Every form of Package AFPS writes into `manifest.json`, but the manifest also
 * holds fields no form covers, so its raw editor stays reachable: a quiet link
 * under the forms (`?editManifest=1`). What it applies joins the same draft the
 * forms write.
 */
export function ManifestEditEntry({
  value,
  schema,
  onApply,
  showLink,
}: {
  value: Record<string, unknown>;
  schema?: { uri: string; schema: object };
  onApply: (value: Record<string, unknown>) => void;
  /** The link sits under forms; the files table has its own "Modifier". */
  showLink: boolean;
}) {
  const { t } = useTranslation("agents");
  const editing = useModalParam("editManifest");
  return (
    <>
      {showLink && (
        <div className="border-border mt-8 border-t pt-4">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-muted-foreground h-auto px-0"
            onClick={() => editing.open()}
          >
            <Braces />
            {t("editor.editManifestLink")}
          </Button>
        </div>
      )}
      {editing.value !== null && (
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
      )}
    </>
  );
}
