import type { ExecutionStatus } from "@appstrate/shared-types";
import { Spinner } from "./spinner";

const badgeClassMap: Record<string, string> = {
  success: "badge-success",
  failed: "badge-failed",
  running: "badge-running",
  pending: "badge-pending",
  timeout: "badge-timeout",
};

export function Badge({ status }: { status: ExecutionStatus }) {
  const cls = badgeClassMap[status] || "badge-pending";
  const isRunning = status === "running" || status === "pending";
  return (
    <span className={`badge ${cls}`}>
      {isRunning && <Spinner />}
      {status}
    </span>
  );
}
