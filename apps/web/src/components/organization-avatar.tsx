// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";

export function OrganizationAvatar({
  name,
  logo,
  className,
}: {
  name: string;
  logo?: string | null;
  className?: string;
}) {
  const emoji = logo?.startsWith("emoji:") ? logo.slice("emoji:".length) : null;
  const image = logo?.startsWith("data:image/webp;base64,") ? logo : null;

  return (
    <span
      className={cn(
        "bg-sidebar-primary text-sidebar-primary-foreground flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-bold",
        className,
      )}
    >
      {image ? (
        <img src={image} alt="" className="size-full object-cover" />
      ) : emoji ? (
        <span aria-hidden className="leading-none">
          {emoji}
        </span>
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </span>
  );
}
