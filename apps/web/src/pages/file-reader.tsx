// SPDX-License-Identifier: Apache-2.0

/**
 * The file reader (`/files/:fileId?org=…&space=…`): one file, full page, in the
 * isolated frame of `FileViewer`. The link always names the file's organization
 * and space, and the file is read there whatever the current context, which only
 * « Ouvrir dans l'espace » changes — in « Tous les espaces » it leaves the mode for the file's
 * space, the one move that shows something new. The header names the file's space whenever it
 * is not the working one the switcher names. An address without them reads as unavailable.
 *
 * Every failure reads the same, so the page never tells a file that does not
 * exist from one the caller may not read.
 */

import { useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SearchX, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { DetailBar } from "../components/detail-bar";
import { FileArtifact } from "../components/file-artifact";
import { HeaderActionButton } from "../components/header-action-button";
import { EmptyState } from "../components/page-states";
import { SpaceNameOf } from "../components/space-name";
import { useEnterSpace } from "../hooks/use-enter-space";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useFile } from "../hooks/use-files";
import { requestScopeChange } from "../hooks/use-unsaved-changes";
import { readerContext, type FileContext } from "../lib/file-link";

export function FileReaderPage() {
  const { t } = useTranslation("files");
  const { fileId = "" } = useParams();
  const [params] = useSearchParams();
  const context = useMemo(() => readerContext(params), [params]);

  if (!context) return <EmptyState icon={SearchX} message={t("reader.unavailable")} />;
  return <FileReader fileId={fileId} context={context} />;
}

function FileReader({ fileId, context }: { fileId: string; context: FileContext }) {
  const { t } = useTranslation(["files", "common"]);
  const navigate = useNavigate();
  const enterSpace = useEnterSpace();
  const overview = useOverviewMode();
  const currentSpaceId = useCurrentSpaceId();
  const { data: file, error } = useFile(fileId, context);

  if (error && !file) return <EmptyState icon={SearchX} message={t("reader.unavailable")} />;

  // The space's Fichiers page, the file's preview open over it.
  const openInSpace = file
    ? () =>
        requestScopeChange(() => {
          // The mode would keep listing every space: the file's own is where it opens.
          if (overview.on) overview.choose(false);
          enterSpace(context.orgId, file.spaceId);
          navigate(`/files?${new URLSearchParams({ preview: file.id }).toString()}`);
        })
    : undefined;

  return (
    <div className="flex flex-col gap-4">
      {file && (
        <DetailBar
          title={file.name}
          icon={
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
              <MimeIcon mime={file.mime} name={file.name} className="size-5" />
            </span>
          }
          trail={[{ label: t("common:nav.files") }]}
          spaces={
            overview.on || file.spaceId !== currentSpaceId ? (
              <SpaceNameOf spaceId={file.spaceId} size="sm" className="shrink-0" />
            ) : undefined
          }
          actions={
            openInSpace && (
              <HeaderActionButton onClick={openInSpace}>
                {t("reader.openInSpace")}
              </HeaderActionButton>
            )
          }
        />
      )}
      {file?.preview_kind === "html" && (
        <Alert variant="warning" icon={ShieldAlert}>
          <AlertDescription>{t("reader.htmlNotice")}</AlertDescription>
        </Alert>
      )}
      <FileArtifact
        fileId={fileId}
        file={file}
        context={context}
        isLoading={!file}
        error={null}
        showName={false}
        openInNewTab={false}
        className="h-[max(28rem,calc(100svh-16rem))]"
      />
    </div>
  );
}
