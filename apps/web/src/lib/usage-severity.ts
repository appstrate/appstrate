// SPDX-License-Identifier: Apache-2.0

// Usage-gauge severity thresholds (percent), shared by every credit/storage gauge.
export const USAGE_WARN = 70;
const USAGE_CRITICAL = 90;

export function getUsageBarColor(usagePercent: number): string {
  if (usagePercent >= USAGE_CRITICAL) return "bg-destructive";
  if (usagePercent >= USAGE_WARN) return "bg-yellow-500";
  return "bg-primary";
}
