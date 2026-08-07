// SPDX-License-Identifier: Apache-2.0

/**
 * Preview panel for one file of a package artifact.
 *
 * SOURCE ONLY, always: every file — HTML, SVG, Markdown, JSON — is shown as
 * text in a read-only editor, never injected, framed, or navigated to. (The
 * download button below does build a blob URL, through
 * `usePackageFileDownload`; it is pinned to an inert MIME type and handed
 * straight to an `<a download>`, so it reaches the disk and never the
 * renderer.) Two reasons for source-only, and the second is the one that
 * decides it:
 *
 *   - these bytes are author-controlled and are served from the platform
 *     origin, so the narrow source guard in
 *     `components/test/package-file-preview-security.test.ts` pins this panel
 *     to Monaco and the download to an inert blob;
 *   - and this surface exists to show what the artifact CONTAINS. A `SKILL.md`
 *     or a `prompt.md` is its YAML frontmatter and its exact whitespace —
 *     rendering it would hide precisely what an author or an auditor opened it
 *     to read.
 *
 * The platform does render author-controlled Markdown elsewhere: the manifest's
 * `description` goes through `<InlineMarkdown>` in `shared-header.tsx`, on
 * react-markdown without `rehype-raw`, so embedded HTML is escaped rather than
 * parsed. So a future "Rendu / Source" toggle here would be a product call
 * about what this panel is for — weigh it on that, not on a claim that no safe
 * rendering mode exists.
 */

import { useTranslation } from "react-i18next";
import { Download, FileWarning } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { formatBytes } from "@appstrate/core/format";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { MonacoEditor } from "../monaco";
import { useTheme } from "../../stores/theme-store";
import { LoadingState, ErrorState } from "../page-states";
import {
  baseName,
  languageForPath,
  previewBlockReason,
  type PackageFileEntry,
} from "../../lib/package-file-tree";
import { usePackageFile, usePackageFileDownload } from "./use-package-file";

interface FilePreviewProps {
  /** Target of the tree's `aria-controls` — see `FileExplorer`. */
  id: string;
  packageId: string;
  version: string | undefined;
  entry: PackageFileEntry;
}

export function FilePreview({ id, packageId, version, entry }: FilePreviewProps) {
  const { t } = useTranslation("agents");
  const { resolvedTheme } = useTheme();
  const { text, isLoading, isError } = usePackageFile(packageId, version, entry);
  const download = usePackageFileDownload(packageId, version);
  // The whole verdict comes from the lib — this component holds no rule of its own.
  const blocked = previewBlockReason(entry);

  return (
    // Named after the file it shows: the panel is a landmark a screen-reader
    // user reaches from the tree, and "region" alone says nothing about which
    // of the artifact's files is in it.
    <div
      id={id}
      role="region"
      aria-label={entry.path}
      className="border-border bg-card flex min-w-0 flex-col rounded-lg border"
    >
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
        {/* "Télécharger le fichier", not "Télécharger": the actions dropdown
            already shows a Download-icon "Télécharger" for the WHOLE archive,
            and both are visible on this tab at the same time. */}
        <Button variant="outline" size="sm" onClick={() => void download(entry.path)}>
          <Download size={14} />
          {t("files.downloadFile")}
        </Button>
      </div>

      {blocked ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
          <FileWarning className="h-10 w-10 opacity-40" aria-hidden />
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
        <LoadingState />
      ) : (
        // No `path` prop on purpose: it makes `@monaco-editor/react` create one
        // model per file URI, and monaco is a module singleton that only ever
        // disposes the current one — browsing a 200-file artifact would retain
        // 200 models for the SPA session. `language` is passed explicitly and no
        // view state is saved, so the URI buys nothing.
        <MonacoEditor
          height="520px"
          language={languageForPath(entry.path)}
          value={text}
          theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            // Monaco's default is the generic "Editor content; press Alt+F1 for
            // options" — which file is open would otherwise be announced
            // nowhere inside the editor.
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
          }}
        />
      )}
    </div>
  );
}
