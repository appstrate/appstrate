// SPDX-License-Identifier: Apache-2.0
//
// Adapted from Vercel AI Elements (`packages/elements/src/artifact.tsx`,
// https://github.com/vercel/ai-elements), Copyright 2023 Vercel, Inc., licensed
// under the Apache License, Version 2.0. Changes: our tokens (the header is the
// muted band of our tables), close is an ordinary action passed by the caller, and a tooltip provider scoped to
// the action rather than assumed at the root.

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../cn.ts";
import { Button } from "./button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";

/** A produced thing (a file, a result) shown with its header and actions. */
const Artifact = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "bg-background flex min-h-0 flex-col overflow-hidden rounded-lg border",
        className,
      )}
      {...props}
    />
  ),
);
Artifact.displayName = "Artifact";

function ArtifactHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-muted/50 flex min-w-0 shrink-0 items-center justify-between gap-3 border-b px-3 py-2",
        className,
      )}
      {...props}
    />
  );
}

function ArtifactTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-foreground truncate text-sm font-medium", className)} {...props} />;
}

function ArtifactDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-muted-foreground text-xs", className)} {...props} />;
}

function ArtifactActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 items-center gap-1", className)} {...props} />;
}

/**
 * An icon button whose label is also its tooltip: the header has no room for
 * words. The tooltip opens on hover and on KEYBOARD focus only: a dialog that
 * autofocuses its first control would otherwise greet every pointer user with a
 * tooltip nobody asked for (Radix skips its own open when the event is
 * default-prevented).
 */
function ArtifactAction({
  label,
  icon: Icon,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & { label: string; icon: LucideIcon }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("text-muted-foreground hover:text-foreground size-8", className)}
            aria-label={label}
            onFocus={(event) => {
              if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
            }}
            {...props}
          >
            <Icon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-0 flex-1 overflow-auto", className)} {...props} />;
}

export {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactDescription,
  ArtifactActions,
  ArtifactAction,
  ArtifactContent,
};
