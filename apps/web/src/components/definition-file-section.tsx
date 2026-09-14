// SPDX-License-Identifier: Apache-2.0

/**
 * A definition file — the prompt, a skill's content — read in place and edited
 * in a modal.
 *
 * One rule for every file of a package: the page shows the text as a reader
 * sees it, never an editor — a read-only editor still looks typeable, and
 * hides the Markdown layout the author wrote. Changing one is always the same
 * gesture: "Modifier", a modal with the editor, "Appliquer". Applying writes into the Définition
 * draft, and the section's save bar saves it with everything else — no second
 * save path, no second lock version to race.
 *
 * The modal has an address (`?edit=1`), so the explorer can send a reader
 * straight to editing a file.
 *
 * A bundle holds more than its main file (a skill's references/, scripts/).
 * Those are not edited here and not previewed twice: the section lists them,
 * flat, each one a way into Explorer › Fichiers, where they are read.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Braces, Pencil } from "lucide-react";
import { formatBytes } from "@appstrate/core/format";
import { Button } from "@appstrate/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { $api } from "../api/client";
import { useModalParam } from "../hooks/use-modal-param";
import { useOrgScope } from "../hooks/use-org-scope";
import { splitPackageRef } from "../lib/package-paths";
import { SettingsHeading } from "./settings/settings-heading";
import { JsonEditor } from "./json-editor";
import { Modal } from "./modal";
import { Markdown } from "./markdown";
import { ContentEditor } from "./package-editor/content-editor";

export function DefinitionFileSection({
  fileName,
  hint,
  value,
  onApply,
  bundle,
}: {
  /** The file's name in the package, shown on the reader and the modal. */
  fileName: string;
  hint?: string;
  value: string;
  onApply: (value: string) => void;
  /** The package whose other files are listed, and where each one is read. */
  bundle?: { packageId: string; filesHref: (path: string) => string };
}) {
  const { t } = useTranslation(["agents", "common"]);
  const editing = useModalParam("edit");
  const { frontmatter, body } = splitFrontmatter(value);

  return (
    <div className="space-y-3">
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="border-border flex h-12 items-center gap-3 border-b px-3">
          <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {fileName}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => editing.open()}>
            <Pencil />
            {t("btn.edit", { ns: "common" })}
          </Button>
        </div>
        <div className="space-y-4 p-5">
          {/* A skill's YAML header is data, not prose: shown as it is written,
              apart from the text Markdown lays out. */}
          {frontmatter && (
            <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
              {frontmatter}
            </pre>
          )}
          {body.trim() ? (
            // Package text: no image fetch, no author-controlled links.
            <Markdown inert>{body}</Markdown>
          ) : (
            <p className="text-muted-foreground text-sm">{t("editor.fileEmpty")}</p>
          )}
        </div>
      </div>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {bundle && <BundleFileList {...bundle} exclude={fileName} />}

      {editing.value !== null && (
        <Modal
          open
          onClose={editing.close}
          title={t("editor.editFile", { name: fileName })}
          className="sm:max-w-5xl"
        >
          <MarkdownFileEditor
            initial={value}
            onApply={(next) => {
              onApply(next);
              editing.close();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** The bundle's other files, flat and read-only: each opens in Explorer › Fichiers. */
function BundleFileList({
  packageId,
  filesHref,
  exclude,
}: {
  packageId: string;
  filesHref: (path: string) => string;
  exclude: string;
}) {
  const { t } = useTranslation("agents");
  const scope = useOrgScope();
  const { data } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    { params: { path: splitPackageRef(packageId), header: scope.header } },
    { enabled: scope.enabled },
  );
  // The manifest is what the forms edit; the main file is the reader above.
  const files = (data?.entries ?? [])
    .filter((entry) => entry.path !== exclude && entry.path !== "manifest.json")
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) return null;
  return (
    <section className="pt-5">
      <SettingsHeading
        level="group"
        title={t("editor.bundleFiles")}
        description={t("editor.bundleFilesHint")}
      />
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("editor.bundleFileColumn")}</TableHead>
              <TableHead className="w-24 text-right">{t("editor.bundleSizeColumn")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((entry) => (
              <TableRow key={entry.path}>
                <TableCell className="font-mono text-xs">
                  <Link to={filesHref(entry.path)} className="hover:underline">
                    {entry.path}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                  {formatBytes(entry.size)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
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
 * The AFPS manifest, edited raw — the escape hatch, not a section.
 *
 * Every form of the Définition writes into `manifest.json`; listing the file
 * beside them read as a second copy of the same content. But the manifest also
 * holds fields no form covers, so its raw editor stays reachable: a quiet link
 * under the forms, and "Modifier" on `manifest.json` in the files explorer,
 * both opening this one modal (`?editManifest=1`). What it applies joins the
 * same draft the forms write.
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
  /** The link sits under forms; a file section (the prompt) has its own editor. */
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

/** A leading `---` YAML block, kept apart from the Markdown body. */
function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match
    ? { frontmatter: match[1]!, body: text.slice(match[0].length) }
    : { frontmatter: null, body: text };
}
