// SPDX-License-Identifier: Apache-2.0

/**
 * THE frame every shown file wears: the run's featured deliverable, the preview
 * modal and the chat's side panel, so the same file reads the same wherever it
 * is opened.
 *
 * Header: type icon and kind, name, size, retention. Actions: copy (text kinds
 * only), download (when the caller may), open in a new tab (the reader page,
 * `/files/:fileId`), copy its link, full screen. The body is `FileViewer`,
 * strict HTML sandbox included.
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
  ExternalLinkIcon,
  LinkIcon,
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
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";
import { useFileDownload, useFileTextCopy } from "../hooks/use-files";
import { useCurrentOrgId } from "../hooks/use-org";
import { mimeKind, type LocalViewableFile } from "../lib/files";
import { fileReaderPath, fileReaderUrl, type FileContext } from "../lib/file-link";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { ExpiryBadge } from "./file-badges";
import { FileViewer, type ViewableFile } from "./file-viewer";

export function FileArtifact({
  fileId,
  file,
  context,
  isLoading,
  error,
  fallbackName = "",
  showName = true,
  openInNewTab = true,
  onClose,
  className,
}: {
  fileId: string;
  /** A stored file, or a picked one not yet sent (`local`: no download, link or retention). */
  file?:
    | (ViewableFile & {
        spaceId: string;
        expiresAt: string | null;
        capabilities: { download: boolean };
      })
    | LocalViewableFile;
  /** The file's organization and space when not the current ones (the reader page). */
  context?: FileContext;
  isLoading: boolean;
  error: unknown;
  /** The name to show before (or without) the fetched DTO. */
  fallbackName?: string;
  /** Off where the container already titles the file (the preview modal). */
  showName?: boolean;
  /** Off on the reader page, which that action opens. */
  openInNewTab?: boolean;
  /** Where the frame IS the container (the chat's side panel): closing it closes that. */
  onClose?: { label: string; onClick: () => void };
  className?: string;
}) {
  const { t } = useTranslation("files");
  const frameRef = useRef<HTMLDivElement>(null);
  const download = useFileDownload(context);
  const copyText = useFileTextCopy(context);
  const copyLink = useCopyToClipboard();
  const currentOrgId = useCurrentOrgId();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const name = fallbackName || file?.name || "";
  const local = file !== undefined && "local" in file;
  const stored = local ? undefined : file;
  const canDownload = stored?.capabilities.download === true;
  const canCopy = canDownload && stored?.preview_kind === "text";
  const orgId = context?.orgId ?? currentOrgId;
  const linkContext = stored && orgId ? { orgId, spaceId: stored.spaceId } : undefined;

  return (
    <Artifact ref={frameRef} className={className}>
      <ArtifactHeader>
        <div className="flex min-w-0 items-center gap-2.5">
          {file && (
            <MimeIcon
              mime={file.mime}
              name={file.name}
              className="text-muted-foreground size-4 shrink-0"
            />
          )}
          <div className="min-w-0">
            {showName && <ArtifactTitle title={name}>{name}</ArtifactTitle>}
            {file && (
              <ArtifactDescription className="flex flex-wrap items-center gap-x-2">
                <span>{t(`type.${mimeKind(file.mime)}`)}</span>
                <span className="tabular-nums">{formatBytes(file.size)}</span>
                {stored && <ExpiryBadge expiresAt={stored.expiresAt} />}
              </ArtifactDescription>
            )}
          </div>
        </div>
        <ArtifactActions>
          {canCopy && (
            <ArtifactAction
              icon={copyText.copied ? CheckIcon : CopyIcon}
              label={copyText.copied ? t("artifact.copied") : t("artifact.copy")}
              onClick={() => void copyText.copy(fileId)}
            />
          )}
          {canDownload && (
            <ArtifactAction
              icon={DownloadIcon}
              label={t("common:btn.download")}
              onClick={() => void download(fileId, name)}
            />
          )}
          {linkContext && openInNewTab && (
            <ArtifactAction
              icon={ExternalLinkIcon}
              label={t("artifact.openInNewTab")}
              onClick={() =>
                window.open(fileReaderPath(fileId, linkContext), "_blank", "noopener,noreferrer")
              }
            />
          )}
          {linkContext && (
            <ArtifactAction
              icon={copyLink.copied ? CheckIcon : LinkIcon}
              label={copyLink.copied ? t("artifact.copied") : t("common:btn.copyLink")}
              onClick={() => void copyLink.copy(fileReaderUrl(fileId, linkContext))}
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
          context={context}
          local={local}
          isLoading={isLoading}
          error={error}
          className="rounded-none border-0"
        />
      </ArtifactContent>
    </Artifact>
  );
}
