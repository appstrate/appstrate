// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Documents" tab. Lists the documents anchored to a run — inputs
 * (user uploads consumed by the run) and outputs (agent-produced files) —
 * filtered client-side by the same purpose tabs as the gallery (the run's
 * documents are fetched in one page, so tab switches don't re-query). The list
 * is invalidated live from the run's SSE stream: `run-detail` invalidates this
 * query when a `document.published` log frame arrives, which is also what
 * refreshes it after a delete (useDeleteDocument invalidates the same query).
 *
 * When the run produced exactly ONE file, that file is featured above the list
 * with an inline preview — the derived rule (#1177) that replaced the agent's
 * `presentation: "primary"` declaration and the Deliverable tab it drove.
 * Several produced files are only listed: the page never picks one for the user.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useDocument, useDocumentDownload, useDocuments } from "../hooks/use-documents";
import { featuredRunDocument } from "../lib/documents";
import { DocumentListPanel, type PurposeFilter } from "./document-list-panel";
import { DocumentViewer } from "./document-viewer";

/**
 * The featured file, previewed in place. Refetches the document on its own
 * (`useDocument`) rather than reusing the list row: `preview_url` carries a
 * short-lived signed token that is minted per single-document GET.
 */
function FeaturedRunDocument({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation("documents");
  const download = useDocumentDownload();
  const { data, isLoading, error } = useDocument(id);
  const documentName = data?.name ?? name;
  const downloadButton = (
    <Button variant="outline" size="sm" onClick={() => void download(id, documentName)}>
      <DownloadIcon className="size-4" />
      {t("row.download")}
    </Button>
  );

  return (
    <section aria-label={t("run.featuredLabel")} className="mb-4 min-w-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
        <h2 className="truncate text-sm font-medium" title={documentName}>
          {documentName}
        </h2>
        {downloadButton}
      </div>
      <DocumentViewer
        documentId={id}
        document={data}
        isLoading={isLoading}
        error={error}
        unavailableAction={downloadButton}
        className="h-[max(24rem,calc(100vh-28rem))]"
      />
    </section>
  );
}

export function RunDocumentsTab({ runId }: { runId: string }) {
  const { t } = useTranslation("documents");
  const { data, isLoading, error } = useDocuments({ runId, limit: 100 });
  const [purpose, setPurpose] = useState<PurposeFilter>("all");

  const documents = useMemo(() => {
    const all = data?.data ?? [];
    return purpose === "all" ? all : all.filter((d) => d.purpose === purpose);
  }, [data?.data, purpose]);

  // Computed off the FULL list, never the filtered view: the rule counts what
  // the run produced, and that count does not change because the user is
  // currently looking at the uploads filter.
  const featured = useMemo(() => featuredRunDocument(data?.data ?? []), [data?.data]);

  return (
    <>
      {featured && purpose !== "user_upload" && (
        <FeaturedRunDocument id={featured.id} name={featured.name} />
      )}
      <DocumentListPanel
        documents={documents}
        isLoading={isLoading}
        error={error}
        purpose={purpose}
        onPurposeChange={setPurpose}
        empty={{ message: t("run.empty"), hint: t("run.emptyHint"), compact: true }}
        runId={runId}
      />
    </>
  );
}
