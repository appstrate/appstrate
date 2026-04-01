import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { InputModal } from "./input-modal";
import { useRunFlow } from "../hooks/use-mutations";
import { useCurrentProfileId, useCurrentOrgProfileId } from "../hooks/use-current-profile";
import { api } from "../api";
import type { FlowDetail } from "@appstrate/shared-types";

interface RunFlowButtonProps {
  packageId: string;
  /** When provided, skips the lazy fetch (detail page case). */
  detail?: FlowDetail;
  version?: string;
  disabled?: boolean;
  disabledTitle?: string;
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  className?: string;
  showLabel?: boolean;
}

export function RunFlowButton({
  packageId,
  detail: providedDetail,
  version,
  disabled,
  disabledTitle,
  variant = "default",
  size = "default",
  className,
  showLabel = false,
}: RunFlowButtonProps) {
  const { t } = useTranslation(["flows"]);
  const profileId = useCurrentProfileId();
  const orgProfileId = useCurrentOrgProfileId();
  const runFlow = useRunFlow(packageId);
  const [fetchedDetail, setFetchedDetail] = useState<FlowDetail | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const detail = providedDetail ?? fetchedDetail;

  const hasInputSchema = !!(
    detail?.input?.schema?.properties && Object.keys(detail.input.schema.properties).length > 0
  );

  const run = () => {
    if (hasInputSchema) {
      setInputOpen(true);
    } else {
      runFlow.mutate({
        profileId: profileId ?? undefined,
        orgProfileId: orgProfileId ?? undefined,
        version,
      });
    }
  };

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (providedDetail) {
      run();
      return;
    }

    // Lazy fetch for list page
    setFetching(true);
    try {
      const qsParts: string[] = [];
      if (profileId) qsParts.push(`profileId=${profileId}`);
      if (orgProfileId) qsParts.push(`orgProfileId=${orgProfileId}`);
      const qs = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";
      const data = await api<{ flow: FlowDetail }>(`/packages/flows/${packageId}${qs}`);
      const flowDetail = data.flow;
      setFetchedDetail(flowDetail);

      const needsInput = !!(
        flowDetail.input?.schema?.properties &&
        Object.keys(flowDetail.input.schema.properties).length > 0
      );

      if (needsInput) {
        setInputOpen(true);
      } else {
        runFlow.mutate({
          profileId: profileId ?? undefined,
          orgProfileId: orgProfileId ?? undefined,
        });
      }
    } catch {
      // Fetch errors are silent — user can retry
    } finally {
      setFetching(false);
    }
  };

  const isPending = fetching || runFlow.isPending;
  const isDisabled = disabled || isPending;

  return (
    <>
      {showLabel ? (
        <Button
          variant={variant}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
        >
          {isPending ? <Spinner /> : t("detail.run")}
        </Button>
      ) : (
        <Button
          variant={variant}
          size={size}
          className={className}
          onClick={handleClick}
          disabled={isDisabled}
          title={disabled ? disabledTitle : t("detail.run")}
        >
          {isPending ? <Spinner /> : <Play size={14} />}
        </Button>
      )}
      {detail && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          flow={detail}
          onSubmit={(input, files) =>
            runFlow.mutate({
              input,
              files,
              profileId: profileId ?? undefined,
              orgProfileId: orgProfileId ?? undefined,
              version,
            })
          }
          isPending={runFlow.isPending}
        />
      )}
    </>
  );
}
