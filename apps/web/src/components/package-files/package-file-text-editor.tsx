// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { languageForPath, type PackageFileEntry } from "../../lib/package-file-tree";
import { ContentEditor } from "../package-editor/content-editor";
import { ErrorState } from "../page-states";
import { TextSkeleton } from "../loading-skeletons";
import { usePackageFile } from "./use-package-file";

/**
 * A text file of a package draft in Monaco. `commit` is when an edit leaves the
 * editor: `"live"` reports every keystroke (the create page, whose parent form
 * saves), `"apply"` holds the text until the Appliquer button (the modal over a
 * detail page, whose save bar saves).
 */
export function PackageFileTextEditor({
  packageId,
  entry,
  path,
  commit,
  onCommit,
  disabled,
}: {
  packageId: string | undefined;
  entry: PackageFileEntry;
  path: string;
  commit: "live" | "apply";
  onCommit: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("agents");
  const { text, isLoading, isError } = usePackageFile(packageId, undefined, entry, true);
  if (isError) return <ErrorState message={t("files.errorLoad")} />;
  if (isLoading || text === undefined) return <TextSkeleton lines={8} />;
  return commit === "live" ? (
    <ContentEditor
      value={text}
      onChange={onCommit}
      language={languageForPath(path)}
      readOnly={disabled}
      // The region label around the editor stops being announced the moment
      // Monaco takes focus; inside the textarea the open file has to name itself.
      ariaLabel={path}
    />
  ) : (
    <ApplyEditor initial={text} path={path} onApply={onCommit} />
  );
}

function ApplyEditor({
  initial,
  path,
  onApply,
}: {
  initial: string;
  path: string;
  onApply: (text: string) => void;
}) {
  const { t } = useTranslation("agents");
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-3">
      <ContentEditor
        value={value}
        onChange={setValue}
        language={languageForPath(path)}
        // Fits a short window: the modal must never push Appliquer off screen.
        height="min(60vh, 560px)"
      />
      <div className="flex justify-end">
        <Button type="button" onClick={() => onApply(value)}>
          {t("editor.apply")}
        </Button>
      </div>
    </div>
  );
}
