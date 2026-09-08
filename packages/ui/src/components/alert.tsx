// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../cn.ts";

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive: "border-destructive/50 text-destructive [&>svg]:text-destructive",
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
  // `children` is destructured and placed explicitly rather than arriving via
  // `{...props}`: a heading whose content is invisible to a static reader is
  // indistinguishable from an empty one, and `jsx-a11y/heading-has-content`
  // reads it as empty. Same rendered output, one fewer blind spot.
  ({ className, children, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn("mb-1 leading-none font-medium tracking-tight", className)}
      {...props}
    >
      {children}
    </h5>
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
