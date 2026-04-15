// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { FileWidgetLabels } from "@appstrate/ui/schema-form";

/**
 * Builds the `labels` prop for `<SchemaForm>` from the i18next `settings`
 * namespace so the shared core widget picks up Appstrate's FR/EN strings.
 */
export function useSchemaFormLabels(): Required<FileWidgetLabels> & { addItem: string } {
  const { t } = useTranslation(["settings", "common"]);
  return {
    uploading: t("file.uploading", { ns: "settings" }),
    uploadsDisabled: t("file.uploadsDisabled", { ns: "settings" }),
    dragDrop: t("file.dragDrop", { ns: "settings" }),
    addFile: t("file.addFile", { ns: "settings" }),
    maxSize: (size) => t("file.maxSize", { ns: "settings", size }),
    maxFiles: (count) => t("file.maxFiles", { ns: "settings", count }),
    formats: (formats) => t("file.formats", { ns: "settings", formats }),
    extError: (name, accept) => t("file.extError", { ns: "settings", name, accept }),
    sizeError: (name, size) => t("file.sizeError", { ns: "settings", name, size }),
    addItem: t("btn.add", { ns: "common" }),
  };
}
