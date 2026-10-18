// SPDX-License-Identifier: Apache-2.0

/**
 * Adding an integration from an MCP server URL, guided: analyse the address, review the proposal,
 * create the draft (activated here, nothing published), connect an account, choose the server's
 * tools, then publish once — the draft's own version (1.0.0) — with them. The only state carried
 * across a reload is `?package=<id>` once the package exists: every later step is read from the
 * package (published version, usable connection, declared tools).
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { $api } from "../api/client";
import { DetailBar } from "../components/detail-bar";
import { TextSkeleton } from "../components/loading-skeletons";
import { ErrorState, ResourceErrorState } from "../components/page-states";
import { AddressStep } from "../components/integration-wizard/address-step";
import { ReviewStep } from "../components/integration-wizard/review-step";
import { ConnectStep } from "../components/integration-wizard/connect-step";
import { ToolsStep } from "../components/integration-wizard/tools-step";
import {
  WizardProgress,
  WizardSection,
  type WizardStepId,
} from "../components/integration-wizard/wizard-section";
import { defaultIntegrationManifest } from "../components/agent-editor/utils";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useCreatePackage } from "../hooks/use-mutations";
import { usePackageActivation } from "../hooks/use-library";
import { PendingButton } from "@/components/app-ui/pending-button";
import { RoleLimitNotice } from "../components/role-limit-notice";
import { usePackageDetail } from "../hooks/use-packages";
import { useIntegrationDetail, type IntegrationDetailWire } from "../hooks/use-integrations";
import { encodeIconDataUri } from "../lib/icon-image";
import { agentCreationWithIntegrationPath } from "../lib/creation-handoff";
import { packageDetailPath } from "../lib/package-paths";
import { integrationSettingsHref } from "../lib/settings-section-href";
import {
  declaredToolNames,
  defaultToolCount,
  integrationCreationManifest,
  integrationWizardStep,
  isCurrentAnalysis,
  isRemoteSource,
  proposalEdits,
  toolsPublishVersion,
  type DiscoveryResult,
  type IntegrationWizardStep,
  wizardCreateBody,
  wizardResumePath,
  type WizardEdits,
} from "../lib/integration-wizard";

const PROGRESS: Record<IntegrationWizardStep, WizardStepId | null> = {
  notRemote: null,
  inactive: null,
  connect: "connect",
  tools: "tools",
  ready: null,
};

export function IntegrationFromMcpUrlPage() {
  const { t } = useTranslation(["agents", "settings"]);
  const [params] = useSearchParams();
  const packageId = params.get("package");
  return (
    <div className="flex flex-col gap-6">
      <DetailBar
        title={t("integrationWizard.title")}
        trail={[{ label: t("integrations.title", { ns: "settings" }), href: "/integrations" }]}
      />
      {packageId ? (
        <ExistingPackageWizard key={packageId} packageId={packageId} />
      ) : (
        <NewIntegrationWizard />
      )}
    </div>
  );
}

interface Review {
  result: DiscoveryResult;
  edits: WizardEdits;
  icon: string | undefined;
}

/** Before the package exists: the address and the review. Nothing is stored. */
function NewIntegrationWizard() {
  const { t } = useTranslation("agents");
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const [url, setUrl] = useState("");
  // The input's value as the last keystroke left it, for a response to tell whether it is stale.
  const latestUrl = useRef("");
  const [review, setReview] = useState<Review | null>(null);
  const analysis = $api.useMutation("post", "/api/integrations/discover", {
    meta: { errorHandledByCaller: true },
  });
  const create = useCreatePackage("integration");
  // « Continuer en configuration manuelle » creates the same draft, then opens its editor.
  const [manual, setManual] = useState(false);

  // While a creation is in flight nothing it was built from may change: its controls are disabled.
  const changeUrl = (next: string) => {
    if (create.isPending) return;
    latestUrl.current = next;
    setUrl(next);
    setReview(null);
    analysis.reset();
    create.reset();
  };

  const analyse = () => {
    const requested = url.trim();
    analysis.mutate(
      { body: { url: requested } },
      {
        onSuccess: (result) => {
          if (!isCurrentAnalysis(latestUrl.current, requested)) return;
          setReview({ result, edits: proposalEdits(result.manifest), icon: result.manifest.icon });
          // A raster the manifest does not take as is is re-encoded; it lands only on this result.
          if (!result.manifest.icon && result.icon_source) {
            void encodeIconDataUri(result.icon_source)
              .then((icon) =>
                setReview((current) =>
                  current?.result === result && !current.icon ? { ...current, icon } : current,
                ),
              )
              .catch(() => {});
          }
        },
      },
    );
  };

  const accepted = (current: Review) =>
    integrationCreationManifest(
      defaultIntegrationManifest(currentOrg?.slug, user?.email),
      current.result.manifest,
      current.edits,
      current.icon,
    );

  // Rendered, not a mutate callback: a re-render during the request cannot lose the package.
  if (create.data) {
    const created = create.data.id;
    const to = manual
      ? integrationSettingsHref(packageDetailPath("integration", created), "identity")
      : wizardResumePath(created);
    return <Navigate to={to} replace />;
  }

  return (
    <>
      <WizardProgress current={review ? "review" : "address"} />
      <AddressStep
        url={url}
        onUrlChange={changeUrl}
        onSubmit={analyse}
        pending={analysis.isPending}
        disabled={create.isPending}
        error={analysis.error}
      />
      {review && (
        <ReviewStep
          result={review.result}
          edits={review.edits}
          onEditsChange={(edits) => {
            if (create.isPending) return;
            setReview({ ...review, edits });
            create.reset();
          }}
          icon={review.icon}
          creating={create.isPending}
          createError={create.error}
          onCreate={() => {
            if (create.isPending) return;
            setManual(false);
            create.mutate(wizardCreateBody(accepted(review)));
          }}
          onManual={() => {
            if (create.isPending) return;
            setManual(true);
            create.mutate(wizardCreateBody(accepted(review)));
          }}
        />
      )}
      <div>
        <Button variant="outline" asChild>
          <Link to="/integrations">{t("btn.cancel", { ns: "common" })}</Link>
        </Button>
      </div>
    </>
  );
}

/** Once the package exists: the step it is at, read from it. */
function ExistingPackageWizard({ packageId }: { packageId: string }) {
  const { t } = useTranslation("agents");
  const draft = usePackageDetail("integration", packageId);
  const integration = useIntegrationDetail(packageId);

  if (draft.isLoading || integration.isLoading) return <TextSkeleton lines={6} />;
  const error = integration.error ?? draft.error;
  if (error) return <ResourceErrorState error={error} />;
  if (!draft.data || !integration.data) return <ErrorState />;

  const detail = integration.data;
  const manifest = detail.manifest as Record<string, unknown>;
  const published = (draft.data.version_count ?? 0) > 0;
  const step = integrationWizardStep({
    remote: isRemoteSource(manifest),
    active: detail.active,
    published,
    connection: detail.proxy_connection.status,
    // The detail reads the published version, else the draft.
    toolsDeclared: declaredToolNames(manifest).length > 0,
  });
  const version = toolsPublishVersion({
    published,
    publishedVersion: detail.manifest.version,
    draftVersion: draft.data.manifest?.version,
  });
  const detailPath = packageDetailPath("integration", packageId);
  const name = detail.manifest.display_name ?? packageId;

  return (
    <>
      <WizardProgress current={PROGRESS[step]} />
      {step !== "ready" && step !== "notRemote" && (
        <p className="text-muted-foreground text-sm">
          {published
            ? t("integrationWizard.resume.published", { name, version: detail.manifest.version })
            : t("integrationWizard.resume.draft", { name })}
        </p>
      )}
      {step === "notRemote" && (
        <WizardSection
          title={t("integrationWizard.notRemote.title")}
          description={t("integrationWizard.notRemote.description", { name })}
        >
          <div>
            <Button asChild>
              <Link to={detailPath}>{t("integrationWizard.open")}</Link>
            </Button>
          </div>
        </WizardSection>
      )}
      {step === "inactive" && <InactiveStep packageId={packageId} name={name} />}
      {step === "connect" && <ConnectStep packageId={packageId} detail={detail} />}
      {step === "tools" &&
        (version ? (
          <ToolsStep
            packageId={packageId}
            draft={draft.data}
            detail={detail}
            connect={<ConnectStep packageId={packageId} detail={detail} />}
            version={version}
            published={published}
          />
        ) : (
          <ErrorState />
        ))}
      {step === "ready" && (
        <ReadyStep packageId={packageId} detail={detail} detailPath={detailPath} />
      )}
      {step !== "ready" && step !== "notRemote" && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link to="/integrations">{t("integrationWizard.resume.later")}</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to={detailPath}>{t("integrationWizard.open")}</Link>
          </Button>
        </div>
      )}
    </>
  );
}

/** Switched off in this space: no call reaches it, so nothing past this step can be done here. */
function InactiveStep({ packageId, name }: { packageId: string; name: string }) {
  const { t } = useTranslation("agents");
  // The integration page's own activation: offered only where the route would accept it.
  const { mayActivate, activate, pending } = usePackageActivation(packageId);
  return (
    <WizardSection
      title={t("integrationWizard.inactive.title")}
      description={t("integrationWizard.inactive.description", { name })}
    >
      {mayActivate ? (
        <div>
          <PendingButton
            type="button"
            onClick={() => activate()}
            pending={pending}
            data-testid="integration-wizard-activate"
          >
            {t("integrationWizard.inactive.activate")}
          </PendingButton>
        </div>
      ) : (
        <RoleLimitNotice>{t("integrationWizard.inactive.noPermission")}</RoleLimitNotice>
      )}
    </WizardSection>
  );
}

function ReadyStep({
  packageId,
  detail,
  detailPath,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  detailPath: string;
}) {
  const { t } = useTranslation("agents");
  const { can } = usePermissions();
  const manifest = detail.manifest as Record<string, unknown>;
  return (
    <WizardSection
      title={t("integrationWizard.ready.title")}
      description={t("integrationWizard.ready.description", {
        name: detail.manifest.display_name,
        version: detail.manifest.version,
      })}
    >
      <p className="text-sm">
        {t("integrationWizard.tools.declared", { count: declaredToolNames(manifest).length })}{" "}
        {t("integrationWizard.tools.selectedCount", { count: defaultToolCount(manifest) })}
      </p>
      {detail.proxy_connection.status === "must_choose" && (
        <p className="text-muted-foreground text-sm">{t("integrationWizard.ready.mustChoose")}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* The agent creation hand-off; it opens only for a caller who may create one. */}
        {can("agents:write") && (
          <Button asChild>
            <Link to={agentCreationWithIntegrationPath(packageId)}>
              {t("integrationWizard.ready.useInAgent")}
            </Link>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to={detailPath}>{t("integrationWizard.ready.open")}</Link>
        </Button>
      </div>
    </WizardSection>
  );
}
