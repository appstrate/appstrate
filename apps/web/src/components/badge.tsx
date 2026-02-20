import { useTranslation } from "react-i18next";
import { Spinner } from "./spinner";

const badgeClassMap: Record<string, string> = {
  success: "badge-success",
  failed: "badge-failed",
  running: "badge-running",
  pending: "badge-pending",
  timeout: "badge-timeout",
  cancelled: "badge-cancelled",
};

export function Badge({ status }: { status: string }) {
  const { t } = useTranslation();
  const cls = badgeClassMap[status] || "badge-pending";
  const isRunning = status === "running" || status === "pending";
  return (
    <span className={`badge ${cls}`}>
      {isRunning && <Spinner />}
      {t(`status.${status}`, status)}
    </span>
  );
}
