// SPDX-License-Identifier: Apache-2.0

/**
 * Preview panel for one file of a package artifact.
 *
 * SOURCE ONLY, always. HTML, SVG, Markdown and JSON are rendered as text in a
 * read-only editor — never injected, framed, or turned into a blob URL. These
 * bytes are author-controlled and reach the platform origin, so there is no
 * rendering mode in which they are safe to interpret.
 */

import { useTranslation } from "react-i18next";
import { Download, FileWarning } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { formatBytes } from "@appstrate/core/format";
import { MonacoEditor } from "../monaco";
import { useTheme } from "../../stores/theme-store";
import { LoadingState, ErrorState } from "../page-states";
import {
  baseName,
  languageForPath,
  previewBlockReason,
  PREVIEW_SIZE_LIMIT,
  type PackageFileEntry,
} from "../../lib/package-file-tree";
import { usePackageFile, usePackageFileDownload } from "./use-package-file";

interface FilePreviewProps {
  packageId: string;
  version: string | undefined;
  entry: PackageFileEntry;
}

export function FilePreview({ packageId, version, entry }: FilePreviewProps) {
  const { t } = useTranslation(["agents", "common"]);
  const { resolvedTheme } = useTheme();
  const { text, isLoading, isError } = usePackageFile(packageId, version, entry);
  const download = usePackageFileDownload(packageId, version);
  // The whole verdict comes from the lib — this component holds no rule of its own.
  const blocked = previewBlockReason(entry);

  const downloadButton = (
    <Button variant="outline" size="sm" onClick={() => void download(entry.path)}>
      <Download size={14} />
      {t("btn.download", { ns: "common" })}
    </Button>
  );

  return (
    <div className="border-border bg-card flex min-w-0 flex-col rounded-lg border">
      <div className="border-border flex items-center gap-3 border-b px-3 py-2">
        <span
          className="text-foreground min-w-0 flex-1 truncate font-mono text-xs"
          title={entry.path}
        >
          {entry.path}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatBytes(entry.size)}
        </span>
        {downloadButton}
      </div>

      {blocked ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
          <FileWarning className="h-10 w-10 opacity-40" aria-hidden />
          <p className="font-mono text-sm">{baseName(entry.path)}</p>
          <p className="text-sm">
            {blocked === "binary"
              ? t("files.notPreviewableBinary")
              : t("files.notPreviewableTooLarge", { limit: formatBytes(PREVIEW_SIZE_LIMIT) })}
          </p>
        </div>
      ) : isError ? (
        <ErrorState />
      ) : isLoading || text === undefined ? (
        <LoadingState />
      ) : (
        <MonacoEditor
          height="520px"
          path={entry.path}
          language={languageForPath(entry.path)}
          value={text}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
          }}
        />
      )}
    </div>
  );
}
