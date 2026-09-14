// SPDX-License-Identifier: Apache-2.0

/**
 * Package AFPS › Fichiers: every file the bundle holds, as one table, for
 * every package type.
 *
 * The package IS its archive, so its Package AFPS group shows the archive:
 * each file with what it is (manifest, main file, reference, script…) and its
 * size. Reading a file is Explorer's job (the tree, the dependencies, the
 * published versions), so "Voir" opens it there; this table is where the
 * draft is changed. What the platform can write is edited from here, in a
 * modal: the type's main file (prompt.md, SKILL.md), an integration's
 * INTEGRATION.md, and manifest.json. The other files arrive with the bundle
 * and are replaced by importing it again.
 *
 * Applying writes into the definition draft; the section's save bar saves it
 * with everything else. Both modals have an address (`?edit=<path>`,
 * `?editManifest=1`), so Explorer can send a reader straight to editing.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Braces, Eye, Pencil } from "lucide-react";
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
import { ContentEditor } from "../package-editor/content-editor";
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

export interface EditableDocument {
  value: string;
  onApply: (value: string) => void;
}

export function PackageFilesSection({
  type,
  packageId,
  manifest,
  documents,
  filesHref,
}: {
  type: PackageType;
  packageId: string;
  /** The draft manifest: its size, and where a local server's entry point is. */
  manifest: Record<string, unknown>;
  /**
   * The text files this draft edits, by path. Listed even when the stored
   * bundle has none yet (an integration's INTEGRATION.md before it is written).
   */
  documents: Record<string, EditableDocument>;
  /** Explorer › Fichiers, opened on that file. */
  filesHref: (path: string) => string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const scope = useOrgScope();
  const editing = useModalParam("edit");
  const editingManifest = useModalParam("editManifest");
  const { data } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    { params: { path: splitPackageRef(packageId), header: scope.header } },
    { enabled: scope.enabled },
  );

  const bytes = (text: string) => new TextEncoder().encode(text).length;
  // The draft's own text for what it edits, so a size follows an applied edit.
  const sizes = new Map((data?.entries ?? []).map((entry) => [entry.path, entry.size]));
  sizes.set("manifest.json", bytes(`${JSON.stringify(manifest, null, 2)}\n`));
  for (const [path, document] of Object.entries(documents)) {
    sizes.set(path, document.value ? bytes(document.value) : (sizes.get(path) ?? 0));
  }
  const rank = (path: string) => {
    const index = ROLE_ORDER.indexOf(bundleFileRole(type, path, manifest));
    return index === -1 ? ROLE_ORDER.length : index;
  };
  const paths = [...sizes.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const editedDocument = editing.value ? documents[editing.value] : undefined;

  return (
    <div className="space-y-3">
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
            {paths.map((path) => {
              const role = bundleFileRole(type, path, manifest);
              const editable = path === "manifest.json" || path in documents;
              const empty = path in documents && !documents[path]!.value;
              return (
                <TableRow key={path}>
                  <TableCell className="font-mono text-xs">{path}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {t(ROLE_LABEL[role])}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                    {empty ? "—" : formatBytes(sizes.get(path) ?? 0)}
                  </TableCell>
                  <TableCell>
                    <TableRowActions menuLabel={t("editor.rowActions", { name: path })}>
                      {!empty && (
                        <DropdownMenuItem asChild>
                          <Link to={filesHref(path)}>
                            <Eye />
                            {t("editor.viewInExplorer")}
                          </Link>
                        </DropdownMenuItem>
                      )}
                      {editable && (
                        <DropdownMenuItem
                          onSelect={() =>
                            path === "manifest.json" ? editingManifest.open() : editing.open(path)
                          }
                        >
                          <Pencil />
                          {t("btn.edit", { ns: "common" })}
                        </DropdownMenuItem>
                      )}
                    </TableRowActions>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">{t("editor.bundleFilesHint")}</p>

      {editing.value !== null && editedDocument && (
        <Modal
          open
          onClose={editing.close}
          title={t("editor.editFile", { name: editing.value })}
          className="sm:max-w-5xl"
        >
          <MarkdownFileEditor
            initial={editedDocument.value}
            onApply={(next) => {
              editedDocument.onApply(next);
              editing.close();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function MarkdownFileEditor({
  initial,
  onApply,
}: {
  initial: string;
  onApply: (value: string) => void;
}) {
  const { t } = useTranslation("agents");
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-3">
      <ContentEditor value={value} onChange={setValue} language="markdown" height="560px" />
      <div className="flex justify-end">
        <Button type="button" onClick={() => onApply(value)}>
          {t("editor.apply")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The AFPS manifest, edited raw: the escape hatch, not a section.
 *
 * Every form of Package AFPS writes into `manifest.json`, but the manifest also
 * holds fields no form covers, so its raw editor stays reachable: a quiet link
 * under the forms, and "Modifier" on `manifest.json` in the files table, both
 * opening this one modal (`?editManifest=1`). What it applies joins the same
 * draft the forms write.
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
