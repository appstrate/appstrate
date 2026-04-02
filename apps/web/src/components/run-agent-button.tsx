// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { InputModal } from "./input-modal";
import { ConnectionSummaryModal } from "./connection-summary-modal";
import { useRunAgent } from "../hooks/use-mutations";
import { api } from "../api";
import { hasDisconnectedProviders } from "../lib/provider-status";
import { packageDetailPath } from "../lib/package-paths";
import { usePermissions } from "../hooks/use-permissions";
import type { AgentDetail } from "@appstrate/shared-types";

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
}: RunAgentButtonProps) {
  const { t } = useTranslation(["agents"]);
  const navigate = useNavigate();
  const { isMember } = usePermissions();
  const runAgent = useRunAgent(packageId);
  const [fetchedDetail, setFetchedDetail] = useState<AgentDetail | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const detail = providedDetail ?? fetchedDetail;

  // Eagerly fetch flow detail on mount (for cards in list/dashboard) so the
  // orange warning badge is visible before the user clicks the button.
  useEffect(() => {
    if (providedDetail || fetchedDetail) return;
    let cancelled = false;
    api<{ agent: AgentDetail }>(`/packages/agents/${packageId}`)
      .then((data) => {
        if (!cancelled) setFetchedDetail(data.agent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [packageId, providedDetail, fetchedDetail]);

  const providers = detail?.dependencies?.providers ?? [];
  const hasProviders = providers.length > 0;
  const hasDisconnected = hasDisconnectedProviders(providers);
  const hasInputSchema = !!(
    detail?.input?.schema?.properties && Object.keys(detail.input.schema.properties).length > 0
  );

  /** Called after the connection summary is confirmed (or skipped if no providers). */
  const proceedAfterSummary = () => {
    setSummaryOpen(false);
    if (hasInputSchema) {
      setInputOpen(true);
    } else {
      runAgent.mutate({ version });
    }
  };

  /** Start the run flow: show summary if providers, otherwise proceed directly. */
  const startRun = () => {
    if (hasProviders) {
      setSummaryOpen(true);
    } else {
      proceedAfterSummary();
    }
  };

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Detail already available (provided or eagerly fetched)
    if (detail) {
      startRun();
      return;
    }

    // Fallback: fetch on click if eager fetch hasn't completed yet
    setFetching(true);
    try {
      const data = await api<{ agent: AgentDetail }>(`/packages/agents/${packageId}`);
      setFetchedDetail(data.agent);

      const agentHasProviders = (data.agent.dependencies?.providers?.length ?? 0) > 0;
      if (agentHasProviders) {
        setSummaryOpen(true);
      } else {
        const needsInput = !!(
          data.agent.input?.schema?.properties &&
          Object.keys(data.agent.input.schema.properties).length > 0
        );
        if (needsInput) {
          setInputOpen(true);
        } else {
          runAgent.mutate({});
        }
      }
    } catch {
      toast.error(t("error.generic", { ns: "common" }));
    } finally {
      setFetching(false);
    }
  };

  const isPending = fetching || runAgent.isPending;
  const isDisabled = disabled || isPending;

  if (!isMember) return null;

  return (
    <>
      {showLabel ? (
        <Button
          variant={variant}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
          className="relative"
        >
          {isPending ? <Spinner /> : t("detail.run")}
          {hasDisconnected && !isPending && (
            <span className="bg-warning absolute -top-1 -right-1 size-2.5 rounded-full" />
          )}
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
          {hasDisconnected && !isPending && (
            <span className="bg-warning absolute -top-1 -right-1 size-2.5 rounded-full" />
          )}
        </Button>
      )}

      {/* Connection summary — always shown before execution when flow has providers */}
      {detail && (
        <ConnectionSummaryModal
          open={summaryOpen}
          onClose={() => setSummaryOpen(false)}
          onConfirm={proceedAfterSummary}
          onConfigureConnections={() => {
            setSummaryOpen(false);
            navigate(`${packageDetailPath("agent", packageId)}#connectors`);
          }}
          providers={detail.dependencies?.providers ?? []}
          orgProfileName={detail.agentOrgProfileName}
          isPending={runAgent.isPending}
        />
      )}

      {/* Input modal — shown after summary confirmation if flow has input schema */}
      {detail && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          flow={detail}
          onSubmit={(input, files) => runAgent.mutate({ input, files, version })}
          isPending={runAgent.isPending}
        />
      )}
    </>
  );
}
