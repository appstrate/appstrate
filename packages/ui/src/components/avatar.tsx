// SPDX-License-Identifier: Apache-2.0

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";

import { cn } from "../cn.ts";

type WithClassName<P> = Omit<P, "className"> & { className?: string };

function Avatar({ className, ...props }: WithClassName<AvatarPrimitive.Root.Props>) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: WithClassName<AvatarPrimitive.Image.Props>) {
  return (
    <AvatarPrimitive.Image className={cn("aspect-square h-full w-full", className)} {...props} />
  );
}

function AvatarFallback({ className, ...props }: WithClassName<AvatarPrimitive.Fallback.Props>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "bg-muted flex h-full w-full items-center justify-center rounded-full",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
