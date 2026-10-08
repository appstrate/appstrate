// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../cn.ts";

// The icon sits on the middle of the text's FIRST line, one line or ten
// (shadcn's grid alert): a 16px icon nudged 2px down centres on a 20px line.
// Every other child takes the text column, whatever element it is.
const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>:not(svg)]:col-start-2 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive: "border-destructive/50 text-destructive [&>svg]:text-destructive",
        // Neither a fault nor a warning: something happened that asks the
        // reader for a decision — a package shared with one of their spaces,
        // which the navigation already badges in this same colour.
        info: "border-primary/40 bg-primary/5 text-foreground [&>svg]:text-primary",
        warning: "border-warning/50 text-warning [&>svg]:text-warning",
        success: "border-success/50 text-success [&>svg]:text-success",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn("font-medium tracking-tight", className)} {...props} />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
