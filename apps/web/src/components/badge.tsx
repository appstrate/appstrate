import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, Clock, Ban } from "lucide-react";
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

const statusIconMap: Record<string, React.ReactNode> = {
  running: <Spinner className="h-3 w-3" />,
  pending: <Spinner className="h-3 w-3" />,
  success: <CheckCircle2 className="h-3 w-3" />,
  failed: <XCircle className="h-3 w-3" />,
  timeout: <Clock className="h-3 w-3" />,
  cancelled: <Ban className="h-3 w-3" />,
};

export function Badge({ status }: { status: string }) {
  const { t } = useTranslation();
  const variant = statusVariantMap[status] || "pending";
  const icon = statusIconMap[status];
  return (
    <UIBadge variant={variant} className="gap-1">
      {icon}
      {t(`status.${status}`, status)}
    </UIBadge>
  );
}
