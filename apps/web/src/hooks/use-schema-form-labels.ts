// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { SchemaFormLabels } from "@appstrate/ui/schema-form";
import { formatBytes } from "../lib/format-bytes";
import { errorMessage } from "../lib/mutation-error";

/**
 * Builds the `labels` prop for `<SchemaForm>` from the i18next `settings`
 * namespace so the shared core widget picks up Appstrate's FR/EN strings.
 */
export function useSchemaFormLabels(): Required<SchemaFormLabels> {
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
    formatSize: formatBytes,
    uploadError: errorMessage,
    addItem: t("btn.add", { ns: "common" }),
    removeItem: t("btn.remove", { ns: "common" }),
    moveItemUp: t("btn.moveUp", { ns: "common" }),
    moveItemDown: t("btn.moveDown", { ns: "common" }),
    // Ajv's `params` carry the bound (`limit`), the expected `type`, the `format`…
    validationError: (keyword, params) =>
      t(`validation.schema.${keyword}`, { ...params, ns: "common", defaultValue: "" }) || undefined,
  };
}
