// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "../cn.ts";

/**
 * One anatomy for every notice: icon, then the text (an optional title over a
 * description), then an optional action. The tone tints the surface, the border
 * and the icon; the text stays in the foreground colour so it reads the same in
 * every tone. A flex row rather than shadcn's grid: the text column wraps the
 * title and the description, so the icon and a one-line description share a
 * line box and the action centres on the whole text.
 */
const alertVariants = cva("relative flex w-full items-start rounded-lg border text-foreground", {
  variants: {
    variant: {
      default: "bg-muted/40 border-border [&>svg]:text-muted-foreground",
      info: "bg-primary/5 border-primary/25 [&>svg]:text-primary",
      warning: "bg-warning/10 border-warning/30 [&>svg]:text-warning",
      destructive: "bg-destructive/5 border-destructive/30 [&>svg]:text-destructive",
      success: "bg-success/10 border-success/30 [&>svg]:text-success",
    },
    size: {
      default: "gap-3 px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4",
      sm: "gap-2 px-3 py-2 text-xs [&>svg]:mt-px [&>svg]:size-3.5",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

const TONE_ICONS: Record<AlertVariant, LucideIcon> = {
  default: Info,
  info: Info,
  warning: TriangleAlert,
  destructive: CircleAlert,
  success: CircleCheck,
};

type AlertProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof alertVariants> & {
    /** Replaces the tone's icon; `false` draws none. */
    icon?: LucideIcon | false;
    /** A control (usually a small button) set at the end of the row. */
    action?: React.ReactNode;
  };

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, size, icon, action, children, ...props }, ref) => {
    const Icon = icon === false ? null : (icon ?? TONE_ICONS[variant ?? "default"]);
    return (
      <div
        ref={ref}
        role="alert"
        data-slot="alert"
        className={cn(alertVariants({ variant, size }), className)}
        {...props}
      >
        {Icon && <Icon aria-hidden className="shrink-0" />}
        <div className="[&:has(>[data-slot=alert-title])>[data-slot=alert-description]]:text-muted-foreground flex min-w-0 flex-1 flex-col gap-0.5">
          {children}
        </div>
        {action && (
          <div data-slot="alert-action" className="-my-1.5 shrink-0 self-center">
            {action}
          </div>
        )}
      </div>
    );
  },
);
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="alert-title"
      className={cn("leading-5 font-medium", className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="alert-description"
      className={cn(
        "leading-5 [&_a]:underline [&_a]:underline-offset-4 [&_p]:leading-5",
        className,
      )}
      {...props}
    />
  ),
);
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
