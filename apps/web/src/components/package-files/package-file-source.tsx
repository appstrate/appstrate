// SPDX-License-Identifier: Apache-2.0

/**
 * Preview panel for one file of a package artifact.
 *
 * SOURCE ONLY: every file (HTML, SVG, Markdown, JSON) is shown as text in a read-only Monaco,
 * never injected, framed or navigated to. The download builds a blob URL pinned to an inert MIME
 * type and handed straight to `<a download>`, so it never reaches the renderer. Why: the bytes are
 * author-controlled and served from the platform origin (guard:
 * `components/test/package-file-preview-security.test.ts`), and this surface exists to show what
 * the artifact CONTAINS (frontmatter, exact whitespace). A "Rendu / Source" toggle would be a
 * product call, not a safety one (`shared-header.tsx` renders Markdown without `rehype-raw`).
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileWarning } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { formatBytes } from "../../lib/format-bytes";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { MonacoEditor } from "../monaco";
import { useTheme } from "../../stores/theme-store";
import { ErrorState } from "../page-states";
import { TextSkeleton } from "../loading-skeletons";
import {
  baseName,
  languageForPath,
  previewBlockReason,
  type PackageFileEntry,
} from "../../lib/package-file-tree";
import { usePackageFile, usePackageFileDownload } from "./use-package-file";

interface PackageFileSourceProps {
  /** Target of the tree's `aria-controls` — see `FileTree`'s `controlsId`. */
  id: string;
  packageId: string | undefined;
  version: string | undefined;
  entry: PackageFileEntry;
  className?: string;
  hideHeader?: boolean;
  /** Extra header controls (*Remplacer*, *Supprimer*): a binary or oversized file has no editable body to host them. */
  actions?: ReactNode;
  /** A staged file has no downloadable server representation yet. */
  downloadPath?: string | null;
}

export function PackageFileSource({
  id,
  packageId,
  version,
  entry,
  className,
  hideHeader = false,
  actions,
  downloadPath = entry.path,
}: PackageFileSourceProps) {
  const { t } = useTranslation("agents");
  const { resolvedTheme } = useTheme();
  const { text, isLoading, isError } = usePackageFile(packageId, version, entry);
  const download = usePackageFileDownload(packageId, version);
  // The whole verdict comes from the lib — this component holds no rule of its own.
  const blocked = previewBlockReason(entry);

  return (
    // Named after the file: a landmark reached from the tree must say which file is in it.
    <div
      id={id}
      role="region"
      aria-label={entry.path}
      className={cn("border-border bg-card flex min-w-0 flex-col rounded-lg border", className)}
    >
      {!hideHeader && (
        <div className="border-border flex h-14 min-h-14 items-center gap-3 border-b px-3 py-2">
          <span
            className="text-foreground min-w-0 flex-1 truncate font-mono text-xs"
            title={entry.path}
          >
            {entry.path}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatBytes(entry.size)}
          </span>
          {/* Not plain "Télécharger": the actions dropdown already offers that for the WHOLE archive. */}
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={t("files.downloadFile")}
            disabled={downloadPath === null}
            onClick={() => downloadPath !== null && void download(downloadPath)}
          >
            <Download />
            <span className="hidden sm:inline">{t("files.downloadFile")}</span>
          </Button>
          {actions}
        </div>
      )}

      {blocked ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
          <FileWarning className="size-10 opacity-40" aria-hidden />
          <p className="font-mono text-sm">{baseName(entry.path)}</p>
          <p className="text-xs">
            {t("files.mediaKind", {
              kind:
                entry.media_kind === "binary"
                  ? t("files.mediaKindBinary")
                  : t("files.mediaKindText"),
            })}
          </p>
          <p className="text-sm">
            {blocked === "binary"
              ? t("files.notPreviewableBinary")
              : t("files.notPreviewableTooLarge", {
                  limit: formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES),
                })}
          </p>
        </div>
      ) : isError ? (
        <ErrorState />
      ) : isLoading || text === undefined ? (
        <TextSkeleton lines={8} />
      ) : (
        // No `path` prop on purpose: it creates one Monaco model per URI, and the singleton only
        // disposes the current one, so browsing a 200-file artifact would retain 200 models.
        <MonacoEditor
          height="520px"
          language={languageForPath(entry.path)}
          value={text}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            ariaLabel: entry.path,
            minimap: { enabled: false },
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            wordBasedSuggestions: "off",
            largeFileOptimizations: true,
            fontSize: 13,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 16, bottom: 16 },
          }}
        />
      )}
    </div>
  );
}
