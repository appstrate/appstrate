// SPDX-License-Identifier: Apache-2.0

/**
 * A definition file — the prompt, a skill's content — read in place and edited
 * in a modal.
 *
 * One rule for every file of a package: the page shows a reader, never an
 * editor. The files explorer reads the same way, so a file looks the same
 * wherever it appears, and changing one is always the same gesture: "Modifier",
 * a modal with the editor, "Appliquer". Applying writes into the Définition
 * draft, and the section's save bar saves it with everything else — no second
 * save path, no second lock version to race.
 *
 * The modal has an address (`?edit=1`), so the explorer can send a reader
 * straight to editing a file.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces, Pencil } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useModalParam } from "../hooks/use-modal-param";
import { useTheme } from "../stores/theme-store";
import { JsonEditor } from "./json-editor";
import { Modal } from "./modal";
import { MonacoEditor } from "./monaco";
import { ContentEditor } from "./package-editor/content-editor";

export function DefinitionFileSection({
  fileName,
  hint,
  value,
  onApply,
}: {
  /** The file's name in the package, shown on the reader and the modal. */
  fileName: string;
  hint?: string;
  value: string;
  onApply: (value: string) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { resolvedTheme } = useTheme();
  const editing = useModalParam("edit");

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
        <MonacoEditor
          height="480px"
          language="markdown"
          value={value}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            ariaLabel: fileName,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
          }}
        />
      </div>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}

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
          {t("editor.jsonApply")}
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
