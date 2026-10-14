// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { cn } from "@appstrate/ui/cn";
import { ORG_LOGO_EMOJI_PREFIX } from "@appstrate/core/validation";
import { orgLogoUrl } from "../lib/org-logo";

export function OrganizationAvatar({
  org,
  className,
}: {
  org: { id: string; name: string; logo?: string | null };
  className?: string;
}) {
  const { logo } = org;
  const emoji = logo?.startsWith(ORG_LOGO_EMOJI_PREFIX)
    ? logo.slice(ORG_LOGO_EMOJI_PREFIX.length)
    : null;
  const image = orgLogoUrl(org.id, logo);
  // An image that fails to load falls back to the initial rather than a broken icon.
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <span
      className={cn(
        "bg-sidebar-primary text-sidebar-primary-foreground flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-bold",
        className,
      )}
    >
      {image && failed !== image ? (
        <img
          src={image}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(image)}
        />
      ) : emoji ? (
        <span aria-hidden className="leading-none">
          {emoji}
        </span>
      ) : (
        org.name.charAt(0).toUpperCase()
      )}
    </span>
  );
}
