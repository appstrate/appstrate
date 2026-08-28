// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { Spinner } from "./spinner";
import { Modal } from "./modal";
import { LoadingState } from "./page-states";
import { RunModal } from "./run-modal";
import type { MissingIntegrationFieldError } from "./missing-connections-modal";
import { useRunAgent } from "../hooks/use-mutations";
import { usePackageDetail } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { ApiError } from "../api/errors";
import type { AgentDetail } from "@appstrate/shared-types";

/**
 * 412 recovery surface — lazy because it is a modal that only ever opens on a
 * failed run kickoff, while this button sits in the eager entry graph (agent
 * list → card → button). Its subtree reaches `IntegrationConnectionPicker` →
 * `@appstrate/core/integration` → `@afps-spec/schema`, which instantiates AJV
 * at module scope; a static edge shipped AJV + semver (~144 kB raw) to every
 * visitor. Keep this import dynamic.
 */
const MissingConnectionsModal = lazy(() =>
  import("./missing-connections-modal").then((m) => ({ default: m.MissingConnectionsModal })),
);

interface RunAgentButtonProps {
  packageId: string;
  /** When provided, skips the lazy fetch (detail page case). */
  detail?: AgentDetail;
  version?: string;
  disabled?: boolean;
  disabledTitle?: string;
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  className?: string;
  showLabel?: boolean;
  /**
   * Render a non-blocking orange badge on the button when the agent's
   * integration connections are not ready for a run. Iso with the run-kickoff
   * 412 / MissingConnectionsModal (same server resolver) — see
   * `useAgentIntegrationsReadiness`. Does NOT disable the button: the user can
   * still click Run and recover through the modal.
   */
  connectionWarning?: boolean;
}

export function RunAgentButton({
  packageId,
  detail: providedDetail,
  version,
  disabled,
  disabledTitle,
  variant = "default",
  size = "default",
  className,
  showLabel = false,
  connectionWarning = false,
}: RunAgentButtonProps) {
  const { t } = useTranslation(["agents"]);
  const { isMember } = usePermissions();
  // The inline run button is an editor affordance: absent a pinned historical
  // version (current/editor view → `version` undefined), it runs the working
  // copy. That intent is made EXPLICIT here as `draft` — the transport hook no
  // longer defaults, so this is the single place the editor's draft choice
  // lives. A historical-version view passes its exact version through verbatim.
  const runVersion = version ?? "draft";
  const runAgent = useRunAgent(packageId);
  const [inputOpen, setInputOpen] = useState(false);
  const [missingErrors, setMissingErrors] = useState<MissingIntegrationFieldError[] | null>(null);

  // Pre-run picks no longer need to be merged into connectionOverrides —
  // the member-pin layer (cascade 4) reads them straight from the DB via
  // the resolver. The MissingConnectionsModal still uses connectionOverrides
  // for per-run one-shot picks (cascade 2).

  // Intercept 412 missing_integration_connection — surface the recovery
  // modal instead of (or alongside) the generic toast. Set via the
  // per-call onError so we open the modal in response to a user action
  // (passes the react-hooks/set-state-in-effect rule) rather than mirroring
  // the mutation's error state in a useEffect.
  const onRunError = (err: unknown) => {
    if (
      err instanceof ApiError &&
      err.status === 412 &&
      err.code === "missing_integration_connection"
    ) {
      const errors = Array.isArray(err.details)
        ? (err.details as MissingIntegrationFieldError[])
        : [];
      setMissingErrors(errors);
    }
  };

  // Skip the fetch when the parent already provided the detail (detail page
  // case). Otherwise the query stays DISABLED — list pages render N of these
  // buttons and eagerly fetching full agent detail per card caused an N+1
  // request burst on mount. The detail is fetched on demand via `refetch()`
  // in `handleClick` instead (and cached by React Query for the next click).
  const {
    data: fetchedDetail,
    isFetching,
    refetch,
  } = usePackageDetail("agent", providedDetail ? undefined : packageId, { enabled: false });

  const detail: AgentDetail | undefined = providedDetail ?? fetchedDetail;

  /** Start the run: open the input modal when the agent declares input, else fire directly. */
  const startRun = (agentDetail: AgentDetail) => {
    const agentHasInput =
      !!agentDetail.input?.schema?.properties &&
      Object.keys(agentDetail.input.schema.properties).length > 0;
    if (!agentHasInput) {
      runAgent.mutate({ version: runVersion }, { onError: onRunError });
      return;
    }
    setInputOpen(true);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Detail already available (provided, or cached from a previous click)
    if (detail) {
      startRun(detail);
      return;
    }

    // Deferred fetch — `isFetching` drives the pending spinner meanwhile.
    void refetch().then((res) => {
      if (res.data) {
        startRun(res.data);
      } else {
        toast.error(t("error.generic", { ns: "common" }));
      }
    });
  };

  const closeMissingModal = () => {
    setMissingErrors(null);
    runAgent.reset();
  };

  const isPending = isFetching || runAgent.isPending;
  const isDisabled = disabled || isPending;

  if (!isMember) return null;

  // Non-blocking warning dot — surfaced when integration connections aren't
  // ready, but the button stays clickable (recovery via MissingConnectionsModal).
  const warningDot = connectionWarning ? (
    <span
      className="absolute -top-1 -right-1 flex size-3"
      data-testid="run-connection-warning"
      title={t("detail.connectionWarning")}
    >
      <span className="bg-warning ring-background size-3 rounded-full ring-2" />
    </span>
  ) : null;

  return (
    <>
      {showLabel ? (
        <Button
          variant={variant}
          size={size}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
          className={cn("relative", className)}
        >
          {isPending ? (
            <Spinner />
          ) : (
            <Play className={cn("size-3.5", variant === "outline" && "text-primary")} />
          )}
          {t("detail.run")}
          {warningDot}
        </Button>
      ) : (
        <Button
          variant={variant}
          size={size}
          className={`relative ${className ?? ""}`}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
        >
          {isPending ? <Spinner /> : <Play size={14} />}
          {warningDot}
        </Button>
      )}

      {detail && (
        <RunModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          agent={detail}
          onSubmit={(input) =>
            runAgent.mutate({ input, version: runVersion }, { onError: onRunError })
          }
          isPending={runAgent.isPending}
        />
      )}

      {missingErrors !== null && (
        // Mounted only while the 412 modal is open — that mount is what
        // triggers the dynamic import. The fallback keeps the same modal
        // frame so the dialog appears immediately and only its body swaps.
        <Suspense
          fallback={
            <Modal open onClose={closeMissingModal} title={t("missingConnections.title")}>
              <LoadingState />
            </Modal>
          }
        >
          <MissingConnectionsModal
            open
            onClose={closeMissingModal}
            errors={missingErrors}
            agentPackageId={packageId}
            {...(detail?.dependencies.integrations
              ? { integrationEntries: detail.dependencies.integrations }
              : {})}
            retrying={runAgent.isPending}
            onRetryWithOverrides={(overrides) => {
              // Re-fire the run with the user's picks. Keep the modal open
              // until the response lands so the picker stays visible if the
              // server returns a fresh 412 (e.g. picks disappeared mid-flight).
              runAgent.mutate(
                { version: runVersion, connectionOverrides: overrides },
                {
                  onSuccess: () => setMissingErrors(null),
                  onError: onRunError,
                },
              );
            }}
          />
        </Suspense>
      )}
    </>
  );
}
