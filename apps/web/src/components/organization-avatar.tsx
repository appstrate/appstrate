// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";
import { ORG_LOGO_EMOJI_PREFIX, ORG_LOGO_WEBP_PREFIX } from "@appstrate/core/validation";

export function OrganizationAvatar({
  name,
  logo,
  className,
}: {
  name: string;
  logo?: string | null;
  className?: string;
}) {
  const emoji = logo?.startsWith(ORG_LOGO_EMOJI_PREFIX)
    ? logo.slice(ORG_LOGO_EMOJI_PREFIX.length)
    : null;
  const image = logo?.startsWith(ORG_LOGO_WEBP_PREFIX) ? logo : null;

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
