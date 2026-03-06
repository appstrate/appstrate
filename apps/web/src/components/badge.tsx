import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";
import { Badge as UIBadge } from "@/components/ui/badge";
import type { BadgeProps } from "@/components/ui/badge";

const statusVariantMap: Record<string, BadgeProps["variant"]> = {
  success: "success",
  failed: "failed",
  running: "running",
  pending: "pending",
  timeout: "timeout",
  cancelled: "cancelled",
};

export function Badge({ status }: { status: string }) {
  const { t } = useTranslation();
  const variant = statusVariantMap[status] || "pending";
  const isRunning = status === "running" || status === "pending";
  return (
    <UIBadge variant={variant} className="gap-1">
      {isRunning && <Spinner className="h-3 w-3" />}
      {t(`status.${status}`, status)}
    </UIBadge>
  );
}
