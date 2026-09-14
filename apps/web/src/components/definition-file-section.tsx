// SPDX-License-Identifier: Apache-2.0

/**
 * A definition file — the prompt, the AFPS manifest — read in place and edited
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
import { Pencil } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useModalParam } from "../hooks/use-modal-param";
import { useTheme } from "../stores/theme-store";
import { JsonEditor } from "./json-editor";
import { Modal } from "./modal";
import { MonacoEditor } from "./monaco";
import { ContentEditor } from "./package-editor/content-editor";

type DefinitionFile =
  | { kind: "markdown"; value: string; onApply: (value: string) => void }
  | {
      kind: "json";
      value: Record<string, unknown>;
      onApply: (value: Record<string, unknown>) => void;
      schema?: { uri: string; schema: object };
    };

export function DefinitionFileSection({
  fileName,
  hint,
  ...file
}: DefinitionFile & {
  /** The file's name in the package, shown on the reader and the modal. */
  fileName: string;
  hint?: string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { resolvedTheme } = useTheme();
  const editing = useModalParam("edit");
  const text = file.kind === "json" ? JSON.stringify(file.value, null, 2) : file.value;

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
          language={file.kind === "json" ? "json" : "markdown"}
          value={text}
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
          {file.kind === "json" ? (
            <JsonEditor
              value={file.value}
              schema={file.schema}
              onApply={(next) => {
                file.onApply(next);
                editing.close();
              }}
            />
          ) : (
            <MarkdownFileEditor
              initial={file.value}
              onApply={(next) => {
                file.onApply(next);
                editing.close();
              }}
            />
          )}
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
