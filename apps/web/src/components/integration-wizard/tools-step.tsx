// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import { isUnauthenticatedIntegration } from "@appstrate/core/integration";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import { PendingButton } from "@/components/app-ui/pending-button";
import { client } from "../../api/client";
import { ApiError } from "../../api/errors";
import { TextSkeleton } from "../loading-skeletons";
import { RoleLimitNotice } from "../role-limit-notice";
import { DiscoveryWarnings } from "../integration-editor/discovery-warnings";
import { SyncConnectionChoice } from "../integration-editor/sync-connection-choice";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { usePermissions } from "../../hooks/use-permissions";
import { invalidateIntegrationQueries } from "../../hooks/use-integrations";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { useCreateVersion, type Versioned } from "../../hooks/use-packages";
import { errorMessage } from "../../lib/mutation-error";
import {
  serverSyncBody,
  syncConnectionCandidates,
  type ServerSyncProposal,
} from "../../lib/integration-server-sync";
import { packageDetailPath } from "../../lib/package-paths";
import {
  catalogConnectionsKey,
  catalogSourceKey,
  docsChoice,
  sameAuths,
  syncConnectionRemedy,
  initialToolSelection,
  toolsUpdateBody,
} from "../../lib/integration-wizard";
import { ConnectStep } from "./connect-step";
import { WizardSection } from "./wizard-section";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { packageKeys } from "../../lib/query-keys";

/**
 * The server's tools, read through the caller's connection once the step shows, to choose from
 * before anything is saved; then one save and one publish: the draft's first version, or the next.
 */
export function ToolsStep({
  packageId,
  draft,
  detail,
  version,
  published,
}: {
  packageId: string;
  /** The package's working copy, saved under its `ETag`. */
  draft: Versioned<OrgPackageItemDetail>;
  /** The integration detail: its published manifest and connections. */
  detail: IntegrationDetailWire;
  /** The version the tools are published as. */
  version: string;
  /** A version is already published: the draft's other changes ship with this one. */
  published: boolean;
}) {
  const { t } = useTranslation("agents");
  const { can } = usePermissions();
  // A draft declaring no auths (AFPS §7.2) is read without the credential proxy.
  const readsWithoutProxy = isUnauthenticatedIntegration(draft.manifest ?? {});
  return (
    <WizardSection
      title={t("integrationWizard.tools.title")}
      description={t("integrationWizard.tools.description")}
    >
      {/* The save is a write in the package's home space, the server's verdict on the draft. */}
      {!draft.home_writable ? (
        <RoleLimitNotice>{t("integrationWizard.tools.notWritable")}</RoleLimitNotice>
      ) : !readsWithoutProxy && !can("credential-proxy:call-own") ? (
        <RoleLimitNotice>{t("integrationWizard.tools.noPermission")}</RoleLimitNotice>
      ) : (
        <ServerCatalog
          packageId={packageId}
          draft={draft}
          detail={detail}
          version={version}
          published={published}
        />
      )}
    </WizardSection>
  );
}

function ServerCatalog({
  packageId,
  draft,
  detail,
  version,
  published,
}: {
  packageId: string;
  draft: Versioned<OrgPackageItemDetail>;
  detail: IntegrationDetailWire;
  version: string;
  published: boolean;
}) {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const authsMatch = sameAuths(draft.manifest ?? {}, detail.manifest);
  // Unset until the proxy asks for a choice: the first read lets it apply the space's governance.
  const [connectionId, setConnectionId] = useState<string>();
  // A read of the server, kept off the `/api/integrations` keys a save invalidates: it is not
  // asked again behind the user's back — but it is keyed on the source and auths it was read
  // from, so a draft pointing elsewhere since is read again, never answered from the cache.
  const catalog = useQuery({
    queryKey: [
      "integration-server-catalog",
      orgId,
      spaceId,
      packageId,
      catalogSourceKey(draft.manifest ?? {}),
      // A connection added or reconnected since (the connect step below) is read again — unless
      // the draft's auths are not the ones a connection is made on (`unpublishedAuths`): then
      // nothing a connect does changes the answer, and nothing reads again by itself.
      authsMatch || !published ? catalogConnectionsKey(detail) : null,
      connectionId ?? null,
    ],
    queryFn: async () => {
      const { data } = await client.POST("/api/integrations/{packageId}/discover", {
        params: { path: { packageId } },
        body: serverSyncBody(connectionId),
      });
      return data!;
    },
    staleTime: Infinity,
    // Each attempt is a credential-proxy call the space's journal records: the user retries.
    retry: false,
  });
  const [selection, setSelection] = useState<ReadonlySet<string>>();
  const [includeDocs, setIncludeDocs] = useState(true);
  // Set once the draft is saved: a failed publish is retried alone, on that save.
  const [saved, setSaved] = useState<{ etag: string | null }>();
  // Whether a save of THIS session wrote `INTEGRATION.md`: only that file is ever deleted.
  const [docsWritten, setDocsWritten] = useState(false);
  // Read when the step opens: our own save sets it afterwards.
  const [unarchivedAtMount] = useState(draft.has_unarchived_changes === true);
  // A publish refused because the draft moved after our save: the next submit saves it again.
  const [draftMoved, setDraftMoved] = useState(false);
  const update = useUpdatePackage("integration", packageId);
  const publish = useCreateVersion("integration", packageId);
  const detailPath = packageDetailPath("integration", packageId);
  // A changed choice is no longer the save a failed publish would retry: the next submit saves it.
  const unsave = () => {
    setSaved(undefined);
    setDraftMoved(false);
    publish.reset();
  };

  if (catalog.isLoading) return <TextSkeleton lines={4} />;
  const remedy = syncConnectionRemedy(catalog.error, { published, authsMatch });
  // The draft changes the authentication a connection is made on: no connect clears this.
  if (remedy === "unpublishedAuths") {
    return (
      <Alert variant="warning" data-testid="integration-wizard-unpublished-auths">
        <AlertDescription>
          {t("integrationWizard.tools.unpublishedAuths")}{" "}
          <Link className="underline underline-offset-4" to={detailPath}>
            {t("integrationWizard.open")}
          </Link>
          <div className="mt-2">
            {/* Re-reads the draft and the detail: a publish or a revert there changes the step.
                Not the server read: through these auths it cannot answer otherwise. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: packageKeys.all });
                void invalidateIntegrationQueries(qc);
              }}
            >
              {t("integrationWizard.tools.checkAgain")}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }
  // No account the draft's auths reach (a connection gone, or never made): connect one here; the
  // read runs again once the detail lists it.
  if (remedy === "connect") {
    return (
      <div className="flex flex-col items-start gap-3">
        <ConnectStep packageId={packageId} detail={detail} />
        <Button type="button" variant="outline" onClick={() => void catalog.refetch()}>
          {t("integrationWizard.tools.retry")}
        </Button>
      </div>
    );
  }
  if (catalog.error || !catalog.data) {
    const choosing = syncConnectionCandidates(catalog.error) !== null;
    return (
      <div className="flex flex-col items-start gap-3">
        {!choosing && (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(catalog.error)}
          </p>
        )}
        <SyncConnectionChoice error={catalog.error} onChoose={setConnectionId} />
        {!choosing && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void catalog.refetch()}>
              {t("integrationWizard.tools.retry")}
            </Button>
            {connectionId && (
              <Button type="button" variant="outline" onClick={() => setConnectionId(undefined)}>
                {t("integrationWizard.tools.otherConnection")}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const proposal = catalog.data;
  // Changes held at mount may be files the step cannot see, or an earlier save of its own: the
  // whole draft is published, so the step warns.
  const otherDraftChanges = published && unarchivedAtMount;
  const selected = selection ?? initialToolSelection(draft.manifest ?? {}, proposal);
  const submit = async () => {
    try {
      let etag = saved?.etag;
      if (!saved) {
        const docs = docsChoice({
          include: includeDocs,
          instructions: proposal.instructions,
          written: docsWritten,
        });
        const result = await update.mutateAsync({
          etag: draft.etag ?? "",
          body: toolsUpdateBody(draft.manifest ?? {}, proposal, {
            selected: proposal.tools.map((tool) => tool.name).filter((name) => selected.has(name)),
            version,
            instructions: docs.instructions,
            removeDocs: docs.removeDocs,
          }),
        });
        etag = result.etag;
        setSaved({ etag });
        setDocsWritten(docs.written);
        setDraftMoved(false);
      }
      try {
        await publish.mutateAsync({ version, etag });
      } catch (err) {
        // That save is not the draft any more (the hook re-reads it): save again on the next submit.
        if (err instanceof ApiError && err.code === "precondition_failed") {
          setSaved(undefined);
          setDraftMoved(true);
        }
        throw err;
      }
      // The published version is what the detail reads: once it lists the tools, the step is done.
      await invalidateIntegrationQueries(qc);
    } catch {
      // Said inline from the mutation that failed.
    }
  };

  return (
    <ToolsChoice
      proposal={proposal}
      selected={selected}
      onSelectedChange={(next) => {
        setSelection(next);
        unsave();
      }}
      includeDocs={includeDocs}
      onIncludeDocsChange={(next) => {
        setIncludeDocs(next);
        unsave();
      }}
      otherDraftChanges={otherDraftChanges}
      detailPath={detailPath}
      onRetry={() => void catalog.refetch()}
      refetching={catalog.isFetching}
      version={version}
      onSubmit={() => void submit()}
      pending={update.isPending || publish.isPending}
      saveError={update.error}
      publishError={saved ? publish.error : null}
      draftMoved={draftMoved}
    />
  );
}

/**
 * Every tool the server lists, the read-only ones pre-checked. A tool left unchecked is still
 * declared: an agent may pick it, it is just not selected by default.
 */
export function ToolsChoice({
  proposal,
  selected,
  onSelectedChange,
  includeDocs,
  onIncludeDocsChange,
  version,
  onSubmit,
  pending,
  saveError,
  publishError,
  draftMoved = false,
  otherDraftChanges,
  detailPath,
  onRetry,
  refetching,
}: {
  proposal: ServerSyncProposal;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: ReadonlySet<string>) => void;
  includeDocs: boolean;
  onIncludeDocsChange: (include: boolean) => void;
  version: string;
  onSubmit: () => void;
  pending: boolean;
  saveError: unknown;
  /** The draft was saved but its version not published. */
  publishError: unknown;
  /** The publish found the draft changed since the save: the next submit saves it again. */
  draftMoved?: boolean;
  /** The draft already differs from the published version: those changes are published too. */
  otherDraftChanges: boolean;
  detailPath: string;
  /** Reads the server's tools again. */
  onRetry: () => void;
  refetching: boolean;
}) {
  const { t } = useTranslation("agents");
  const names = proposal.tools.map((tool) => tool.name);
  if (names.length === 0)
    return (
      <div className="flex flex-col items-start gap-3">
        <DiscoveryWarnings warnings={proposal.warnings} />
        <p className="text-sm" data-testid="integration-wizard-no-tools">
          {t("integrationWizard.tools.none")}
        </p>
        <div className="flex flex-wrap gap-2">
          <PendingButton type="button" variant="outline" onClick={onRetry} pending={refetching}>
            {t("integrationWizard.tools.retry")}
          </PendingButton>
          <Button type="button" variant="outline" asChild>
            <Link to={detailPath}>{t("integrationWizard.open")}</Link>
          </Button>
        </div>
      </div>
    );
  const count = names.filter((name) => selected.has(name)).length;
  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(name);
    else next.delete(name);
    onSelectedChange(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <DiscoveryWarnings warnings={proposal.warnings} />
      <div className="flex flex-col gap-1 text-sm">
        <p>
          {/* Nothing is declared yet: the server offers, the save declares. */}
          {t("integrationWizard.tools.offered", { count: names.length })}{" "}
          {t("integrationWizard.tools.toSelectCount", { count })}
        </p>
        <p className="text-muted-foreground">{t("integrationWizard.tools.selectionHint")}</p>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onSelectedChange(new Set(names))}
        >
          {t("integrationWizard.tools.selectAll")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onSelectedChange(new Set())}
        >
          {t("integrationWizard.tools.selectNone")}
        </Button>
      </div>
      <div
        role="group"
        aria-label={t("integrationWizard.tools.listLabel")}
        className="border-border flex flex-col gap-3 rounded-md border p-4"
      >
        {proposal.tools.map((tool) => (
          <CheckboxField
            key={tool.name}
            id={`integration-wizard-tool-${tool.name}`}
            disabled={pending}
            checked={selected.has(tool.name)}
            onCheckedChange={(checked) => toggle(tool.name, checked === true)}
            label={
              <span className="flex flex-wrap items-center gap-2">
                {tool.title ?? <code>{tool.name}</code>}
                {/* One badge: a server marking a tool both read-only and destructive is shown
                    read-only, but such a tool is never pre-checked (`initialToolSelection`). */}
                {tool.read_only ? (
                  <Badge variant="secondary" className="font-normal">
                    {t("integrationWizard.tools.readOnly")}
                  </Badge>
                ) : tool.destructive ? (
                  <Badge variant="destructive" className="font-normal">
                    {t("integrationWizard.tools.destructive")}
                  </Badge>
                ) : null}
              </span>
            }
            description={
              // A server's description runs up to a kilobyte: two lines here, the rest on hover.
              tool.description && (
                <span className="line-clamp-2" title={tool.description}>
                  {tool.description}
                </span>
              )
            }
          />
        ))}
      </div>
      {proposal.instructions && (
        <div className="flex flex-col gap-2">
          <CheckboxField
            id="integration-wizard-docs"
            disabled={pending}
            checked={includeDocs}
            onCheckedChange={(checked) => onIncludeDocsChange(checked === true)}
            label={t("integrationWizard.tools.docs")}
          />
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group">
                <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
                {t("integrationWizard.tools.docsPreview")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="bg-muted mt-2 max-h-80 overflow-auto rounded-md p-3 text-xs">
                <span className="whitespace-pre-wrap">{proposal.instructions}</span>
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
      <div className="border-border flex flex-col gap-3 border-t pt-4">
        {otherDraftChanges && (
          <Alert variant="warning" data-testid="integration-wizard-draft-changes">
            <AlertDescription>
              {t("integrationWizard.tools.otherDraftChanges", { version })}{" "}
              <Link className="underline underline-offset-4" to={detailPath}>
                {t("integrationWizard.tools.reviewDraft")}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {saveError != null && (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(saveError)}
          </p>
        )}
        {draftMoved && (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-testid="integration-wizard-draft-moved"
          >
            {t("integrationWizard.tools.draftMoved", { version })}
          </p>
        )}
        {publishError != null && (
          <p role="alert" className="text-destructive text-sm">
            {t("integrationWizard.tools.publishFailed", { version })} {errorMessage(publishError)}
          </p>
        )}
        <div>
          <PendingButton
            type="button"
            onClick={onSubmit}
            pending={pending}
            data-testid="integration-wizard-publish"
          >
            {publishError != null
              ? t("integrationWizard.tools.retryPublish", { version })
              : t("integrationWizard.tools.submit", { version })}
          </PendingButton>
        </div>
      </div>
    </div>
  );
}
