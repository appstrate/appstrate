import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, ChevronDown, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "./spinner";
import { InputModal } from "./input-modal";
import { useRunFlow } from "../hooks/use-mutations";
import { useCurrentProfileId } from "../hooks/use-current-profile";
import { useProxies, useFlowProxy, useSetFlowProxy } from "../hooks/use-proxies";
import { useOrg } from "../hooks/use-org";
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
  /** Show the proxy split dropdown (detail page only). */
  showProxy?: boolean;
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
  showProxy = false,
}: RunFlowButtonProps) {
  const { t } = useTranslation(["flows", "settings"]);
  const profileId = useCurrentProfileId();
  const runFlow = useRunFlow(packageId);
  const [fetchedDetail, setFetchedDetail] = useState<FlowDetail | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  const { isOrgAdmin } = useOrg();
  const { data: orgProxies } = useProxies();
  const { data: flowProxy } = useFlowProxy(showProxy ? packageId : undefined);
  const setFlowProxy = useSetFlowProxy(packageId);

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

  // Determine if proxy indicator should show
  const hasProxies = showProxy && isOrgAdmin && orgProxies && orgProxies.length > 0;
  const flowProxyId = flowProxy?.proxyId; // null = inherit, "none" = no proxy, string = specific
  const isInherit = !flowProxyId;
  const orgDefaultProxy = orgProxies?.find((p) => p.isDefault && p.enabled);
  // Effective proxy: inherit resolves to org default, otherwise the specific selection
  const effectiveProxy = isInherit
    ? orgDefaultProxy
    : orgProxies?.find((p) => p.id === flowProxyId);
  const hasActiveProxy = !!effectiveProxy;
  const activeProxyLabel = effectiveProxy?.label;

  return (
    <>
      {hasProxies ? (
        <div className="inline-flex rounded-md">
          <Button
            variant={variant}
            size={size}
            className={`${className ?? ""} rounded-r-none border-r border-r-primary-foreground/20`}
            onClick={handleClick}
            disabled={disabled || isPending}
            title={
              disabled
                ? disabledTitle
                : hasActiveProxy
                  ? `${t("detail.run")} (${activeProxyLabel})`
                  : t("detail.run")
            }
          >
            {isPending ? (
              <Spinner />
            ) : (
              <>
                {hasActiveProxy && <Shield size={14} />}
                {showLabel && t("detail.run")}
                {!showLabel && !hasActiveProxy && <Play size={14} />}
              </>
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={variant}
                size={size}
                className="rounded-l-none px-1.5"
                disabled={disabled || isPending || setFlowProxy.isPending}
              >
                <ChevronDown size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => setFlowProxy.mutate(null)}
                className={isInherit ? "font-medium" : ""}
              >
                {orgDefaultProxy && <Shield size={14} />}
                {t("proxies.flow.inherit", { ns: "settings" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setFlowProxy.mutate("none")}
                className={flowProxyId === "none" ? "font-medium" : ""}
              >
                {t("proxies.flow.none", { ns: "settings" })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {orgProxies!.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => setFlowProxy.mutate(p.id)}
                  className={flowProxyId === p.id ? "font-medium" : ""}
                >
                  <Shield size={14} />
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
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
      )}
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
