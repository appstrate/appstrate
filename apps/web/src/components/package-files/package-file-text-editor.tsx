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
 * A text file of a package draft in Monaco. An edit leaves the editor only through the Appliquer
 * button (the modal over a detail page, whose save bar saves).
 */
export function PackageFileTextEditor({
  packageId,
  entry,
  path,
  onCommit,
}: {
  packageId: string | undefined;
  entry: PackageFileEntry;
  path: string;
  onCommit: (text: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { text, isLoading, isError } = usePackageFile(packageId, undefined, entry, true);
  if (isError) return <ErrorState message={t("files.errorLoad")} />;
  if (isLoading || text === undefined) return <TextSkeleton lines={8} />;
  return <ApplyEditor initial={text} path={path} onApply={onCommit} />;
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
