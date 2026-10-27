// SPDX-License-Identifier: Apache-2.0

import { Ban, CheckCircle2, Clock, XCircle } from "lucide-react";
import { cn } from "../cn.ts";
import { Spinner } from "./spinner.tsx";

const TONE = {
  success: "text-success",
  failed: "text-destructive",
  running: "text-primary",
  pending: "text-muted-foreground",
  timeout: "text-warning",
  cancelled: "text-muted-foreground",
};

const ENDED_ICON = {
  success: CheckCircle2,
  failed: XCircle,
  timeout: Clock,
  cancelled: Ban,
};

/**
 * The glyph of a run status, in the theme's semantic tone: a spinner while the
 * run is going, a distinct icon per way it ended. Nothing for an unknown status.
 */
export function RunStatusIcon({ status, className }: { status: string; className?: string }) {
  const tone = TONE[status as keyof typeof TONE];
  if (!tone) return null;
  if (status === "running" || status === "pending") {
    return <Spinner className={cn(tone, className)} />;
  }
  const Icon = ENDED_ICON[status as keyof typeof ENDED_ICON];
  return <Icon className={cn(tone, className)} />;
}
