// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
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
import { toolsUpdateBody } from "../../lib/integration-wizard";
import { WizardSection } from "./wizard-section";

/**
 * The server's tools, read through the caller's connection once the step shows, to choose from
 * before anything is saved; then one save and one publish of the next version.
 */
export function ToolsStep({
  packageId,
  draft,
  version,
}: {
  packageId: string;
  /** The package's working copy, saved under its `ETag`. */
  draft: Versioned<OrgPackageItemDetail>;
  /** The version the tools are published as. */
  version: string;
}) {
  const { t } = useTranslation("agents");
  const { can } = usePermissions();
  return (
    <WizardSection
      title={t("integrationWizard.tools.title")}
      description={t("integrationWizard.tools.description")}
    >
      {/* The save is a write in the package's home space, the server's verdict on the draft. */}
      {!draft.home_writable ? (
        <RoleLimitNotice>{t("integrationWizard.tools.notWritable")}</RoleLimitNotice>
      ) : !can("credential-proxy:call-own") ? (
        <RoleLimitNotice>{t("integrationWizard.tools.noPermission")}</RoleLimitNotice>
      ) : (
        <ServerCatalog packageId={packageId} draft={draft} version={version} />
      )}
    </WizardSection>
  );
}

function ServerCatalog({
  packageId,
  draft,
  version,
}: {
  packageId: string;
  draft: Versioned<OrgPackageItemDetail>;
  version: string;
}) {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  // Unset until the proxy asks for a choice: the first read lets it apply the space's governance.
  const [connectionId, setConnectionId] = useState<string>();
  // A read of the server, kept off the `/api/integrations` keys a save invalidates: it is not
  // asked again behind the user's back.
  const catalog = useQuery({
    queryKey: ["integration-server-catalog", orgId, spaceId, packageId, connectionId ?? null],
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
  // Read before this step saves anything: afterwards the draft differs from the version by our save.
  const [otherDraftChanges] = useState(draft.has_unarchived_changes === true);
  const update = useUpdatePackage("integration", packageId);
  const publish = useCreateVersion("integration", packageId);
  const detailPath = packageDetailPath("integration", packageId);
  // A changed choice is no longer the save a failed publish would retry: the next submit saves it.
  const unsave = () => {
    setSaved(undefined);
    publish.reset();
  };

  if (catalog.isLoading) return <TextSkeleton lines={4} />;
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
  const selected = selection ?? new Set(proposal.manifest.default_tools);
  const submit = async () => {
    try {
      let etag = saved?.etag;
      if (!saved) {
        const result = await update.mutateAsync({
          etag: draft.etag ?? "",
          body: toolsUpdateBody(draft.manifest ?? {}, proposal, {
            selected: proposal.tools.map((tool) => tool.name).filter((name) => selected.has(name)),
            version,
            instructions: includeDocs ? proposal.instructions : null,
          }),
        });
        etag = result.etag;
        setSaved({ etag });
      }
      await publish.mutateAsync({ version, etag });
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
          {t("integrationWizard.tools.declared", { count: names.length })}{" "}
          {t("integrationWizard.tools.selectedCount", { count })}
        </p>
        <p className="text-muted-foreground">{t("integrationWizard.tools.selectionHint")}</p>
      </div>
      {names.length > 0 && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelectedChange(new Set(names))}
          >
            {t("integrationWizard.tools.selectAll")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelectedChange(new Set())}
          >
            {t("integrationWizard.tools.selectNone")}
          </Button>
        </div>
      )}
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
                {tool.read_only && (
                  <Badge variant="secondary" className="font-normal">
                    {t("integrationWizard.tools.readOnly")}
                  </Badge>
                )}
              </span>
            }
            description={tool.description}
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
