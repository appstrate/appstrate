// SPDX-License-Identifier: Apache-2.0

/**
 * Adding an integration from an MCP server URL, guided: analyse the address, review the proposal,
 * create and publish 1.0.0, connect an account, choose the server's tools, publish them. The only
 * state carried across a reload is `?package=<id>` once the package exists: every later step is
 * read from the package (published version, usable connection, declared tools).
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
import { usePackageDetail } from "../hooks/use-packages";
import { useIntegrationDetail, type IntegrationDetailWire } from "../hooks/use-integrations";
import { encodeIconDataUri } from "../lib/icon-image";
import { packageCreateBody } from "../lib/package-file-drafts";
import { packageDetailPath } from "../lib/package-paths";
import { integrationSettingsHref } from "../lib/settings-section-href";
import {
  declaredToolNames,
  defaultToolCount,
  integrationCreationManifest,
  integrationWizardStep,
  manualCreationState,
  nextMinorVersion,
  proposalEdits,
  type DiscoveryResult,
  type IntegrationWizardStep,
  wizardResumePath,
  type WizardEdits,
} from "../lib/integration-wizard";

const PROGRESS: Record<IntegrationWizardStep, WizardStepId | null> = {
  unpublished: "review",
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
  const navigate = useNavigate();
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

  const changeUrl = (next: string) => {
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
          if (latestUrl.current.trim() !== requested) return;
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

  return (
    <>
      <WizardProgress current={review ? "review" : "address"} />
      <AddressStep
        url={url}
        onUrlChange={changeUrl}
        onSubmit={analyse}
        pending={analysis.isPending}
        error={analysis.error}
      />
      {review && (
        <ReviewStep
          result={review.result}
          edits={review.edits}
          onEditsChange={(edits) => {
            setReview({ ...review, edits });
            create.reset();
          }}
          icon={review.icon}
          creating={create.isPending}
          createError={create.error}
          onCreate={() =>
            create.mutate(packageCreateBody({ manifest: accepted(review) }, "integration"), {
              onSuccess: (data) => navigate(wizardResumePath(data.id), { replace: true }),
            })
          }
          onManual={() =>
            navigate("/integrations/new", { state: manualCreationState(accepted(review)) })
          }
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
  const step = integrationWizardStep({
    published: (draft.data.version_count ?? 0) > 0,
    connected: detail.auths.some((auth) => auth.ready),
    toolsDeclared: declaredToolNames(manifest).length > 0,
  });
  const version = nextMinorVersion(detail.manifest.version);
  const detailPath = packageDetailPath("integration", packageId);
  const name = detail.manifest.display_name ?? packageId;

  return (
    <>
      <WizardProgress current={PROGRESS[step]} />
      {step !== "ready" && (
        <p className="text-muted-foreground text-sm">
          {t(
            step === "unpublished"
              ? "integrationWizard.resume.createdUnpublished"
              : "integrationWizard.resume.created",
            { name, version: detail.manifest.version },
          )}
        </p>
      )}
      {step === "unpublished" && (
        <WizardSection
          title={t("integrationWizard.unpublished.title")}
          description={t("integrationWizard.unpublished.description")}
        >
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={integrationSettingsHref(detailPath, "identity")}>
                {t("integrationWizard.unpublished.edit")}
              </Link>
            </Button>
          </div>
        </WizardSection>
      )}
      {step === "connect" && <ConnectStep packageId={packageId} detail={detail} />}
      {step === "tools" &&
        (version ? (
          <ToolsStep packageId={packageId} draft={draft.data} version={version} />
        ) : (
          <ErrorState />
        ))}
      {step === "ready" && <ReadyStep detail={detail} detailPath={detailPath} />}
      {step !== "ready" && (
        <div>
          <Button variant="outline" asChild>
            <Link to="/integrations">{t("integrationWizard.resume.later")}</Link>
          </Button>
        </div>
      )}
    </>
  );
}

function ReadyStep({ detail, detailPath }: { detail: IntegrationDetailWire; detailPath: string }) {
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
      <div className="flex flex-wrap gap-2">
        {/* The agent creation hand-off; it opens only for a caller who may create one. */}
        {can("agents:write") && (
          <Button asChild>
            <Link to="/agents?create=agent">{t("integrationWizard.ready.useInAgent")}</Link>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to={detailPath}>{t("integrationWizard.ready.open")}</Link>
        </Button>
      </div>
    </WizardSection>
  );
}
