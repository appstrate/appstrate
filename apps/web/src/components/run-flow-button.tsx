import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { InputModal } from "./input-modal";
import { useRunFlow } from "../hooks/use-mutations";
import { useCurrentProfileId } from "../hooks/use-current-profile";
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
      runFlow.mutate({ profileId: profileId ?? undefined, version });
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
      const qs = profileId ? `?profileId=${profileId}` : "";
      const flowDetail = await api<FlowDetail>(`/flows/${packageId}${qs}`);
      setFetchedDetail(flowDetail);

      const needsInput = !!(
        flowDetail.input?.schema?.properties &&
        Object.keys(flowDetail.input.schema.properties).length > 0
      );

      if (needsInput) {
        setInputOpen(true);
      } else {
        runFlow.mutate({ profileId: profileId ?? undefined });
      }
    } catch {
      // Fetch errors are silent — user can retry
    } finally {
      setFetching(false);
    }
  };

  const isPending = fetching || runFlow.isPending;

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={handleClick}
        disabled={disabled || isPending}
        title={disabled ? disabledTitle : t("detail.run")}
      >
        {isPending ? <Spinner /> : showLabel ? null : <Play size={14} />}
        {showLabel && (isPending ? null : t("detail.run"))}
      </Button>
      {detail && (
        <InputModal
          open={inputOpen}
          onClose={() => setInputOpen(false)}
          flow={detail}
          onSubmit={(input, files) =>
            runFlow.mutate({ input, files, profileId: profileId ?? undefined, version })
          }
          isPending={runFlow.isPending}
        />
      )}
    </>
  );
}
