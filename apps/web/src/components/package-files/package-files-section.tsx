// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useModalParam } from "../../hooks/use-modal-param";
import { JsonEditor } from "../json-editor";
import { Modal } from "../modal";

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
