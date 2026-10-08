// SPDX-License-Identifier: Apache-2.0

/**
 * THE frame every shown file wears: the run's featured deliverable, the preview
 * modal and the chat's side panel. Before it, each drew its own header (a name
 * here, a download there, a maximise only in the chat), so the same file read
 * differently depending on where it was opened.
 *
 * Header: type icon and kind, name, size, retention. Actions: copy (text kinds
 * only), download (when the caller may), full screen. The body is `FileViewer`
 * unchanged, strict HTML sandbox included.
 *
 * Full screen is the browser's own (`requestFullscreen` on the frame), not a
 * second modal: it works the same inside a page, a modal or a panel, and Escape
 * leaves it natively.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { formatBytes } from "../lib/format-bytes";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@appstrate/ui/components/artifact";
import { useFileDownload, useFileTextCopy } from "../hooks/use-files";
import { mimeKind } from "../lib/files";
import { ExpiryBadge, MimeIcon } from "./file-tile";
import { FileViewer, type ViewableFile } from "./file-viewer";

const COPIED_FEEDBACK_MS = 1500;

export function FileArtifact({
  fileId,
  file,
  isLoading,
  error,
  fallbackName = "",
  showName = true,
  onClose,
  className,
}: {
  fileId: string;
  file?: ViewableFile & {
    expiresAt: string | null;
    capabilities: { download: boolean };
  };
  isLoading: boolean;
  error: unknown;
  /** The name to show before (or without) the fetched DTO. */
  fallbackName?: string;
  /** Off where the container already titles the file (the preview modal). */
  showName?: boolean;
  /** Where the frame IS the container (the chat's side panel): closing it closes that. */
  onClose?: { label: string; onClick: () => void };
  className?: string;
}) {
  const { t } = useTranslation("files");
  const frameRef = useRef<HTMLDivElement>(null);
  const download = useFileDownload();
  const copyText = useFileTextCopy();
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const name = fallbackName || file?.name || "";
  const canDownload = file?.capabilities.download === true;
  const canCopy = canDownload && file?.preview_kind === "text";

  return (
    <Artifact ref={frameRef} className={className}>
      <ArtifactHeader>
        <div className="flex min-w-0 items-center gap-2.5">
          {file && <MimeIcon mime={file.mime} className="text-muted-foreground size-4 shrink-0" />}
          <div className="min-w-0">
            {showName && <ArtifactTitle title={name}>{name}</ArtifactTitle>}
            {file && (
              <ArtifactDescription className="flex flex-wrap items-center gap-x-2">
                <span>{t(`type.${mimeKind(file.mime)}`)}</span>
                <span className="tabular-nums">{formatBytes(file.size)}</span>
                <ExpiryBadge expiresAt={file.expiresAt} />
              </ArtifactDescription>
            )}
          </div>
        </div>
        <ArtifactActions>
          {canCopy && (
            <ArtifactAction
              icon={copied ? CheckIcon : CopyIcon}
              label={copied ? t("artifact.copied") : t("artifact.copy")}
              onClick={() => void copyText(fileId).then(setCopied)}
            />
          )}
          {canDownload && (
            <ArtifactAction
              icon={DownloadIcon}
              label={t("row.download")}
              onClick={() => void download(fileId, name)}
            />
          )}
          <ArtifactAction
            icon={fullscreen ? Minimize2Icon : Maximize2Icon}
            label={fullscreen ? t("artifact.exitFullscreen") : t("artifact.fullscreen")}
            onClick={() =>
              void (fullscreen ? document.exitFullscreen() : frameRef.current?.requestFullscreen())
            }
          />
          {onClose && (
            <ArtifactAction icon={XIcon} label={onClose.label} onClick={onClose.onClick} />
          )}
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent>
        <FileViewer
          fileId={fileId}
          file={file}
          isLoading={isLoading}
          error={error}
          className="rounded-none border-0"
        />
      </ArtifactContent>
    </Artifact>
  );
}
