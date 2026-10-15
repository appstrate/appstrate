// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { cn } from "@appstrate/ui/cn";
import { Alert } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";

const BADGE_TONES = {
  success: "border-transparent bg-success/20 text-success",
  warning: "border-transparent bg-warning/20 text-warning",
  running: "border-transparent bg-primary/20 text-primary",
  pending: "border-transparent bg-muted text-muted-foreground",
  timeout: "border-transparent bg-warning/20 text-warning",
  cancelled: "border-transparent bg-muted text-muted-foreground",
  failed: "border-transparent bg-destructive/20 text-destructive",
} as const;

type NativeBadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;
export type ToneBadgeVariant = NativeBadgeVariant | keyof typeof BADGE_TONES;

/** A shadcn `Badge` in a status tone (run state, health), drawn from the theme's semantic colours. */
export function ToneBadge({
  variant = "default",
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, "variant"> & { variant?: ToneBadgeVariant | null }) {
  const tone =
    variant && variant in BADGE_TONES ? BADGE_TONES[variant as keyof typeof BADGE_TONES] : "";
  return (
    <Badge
      variant={tone ? "outline" : ((variant ?? "default") as NativeBadgeVariant)}
      className={cn(tone, className)}
      {...props}
    />
  );
}

const ALERT_TONES = {
  info: "border-primary/40 bg-primary/5 text-foreground [&>svg]:text-primary",
  warning: "border-warning/50 text-warning [&>svg]:text-warning",
  success: "border-success/50 text-success [&>svg]:text-success",
} as const;

type NativeAlertVariant = NonNullable<ComponentProps<typeof Alert>["variant"]>;

/** A shadcn `Alert` in an info / warning / success tone. */
export function ToneAlert({
  variant = "default",
  className,
  ...props
}: Omit<ComponentProps<typeof Alert>, "variant"> & {
  variant?: NativeAlertVariant | keyof typeof ALERT_TONES | null;
}) {
  const tone =
    variant && variant in ALERT_TONES ? ALERT_TONES[variant as keyof typeof ALERT_TONES] : "";
  return (
    <Alert
      variant={tone ? "default" : ((variant ?? "default") as NativeAlertVariant)}
      className={cn(tone, className)}
      {...props}
    />
  );
}
