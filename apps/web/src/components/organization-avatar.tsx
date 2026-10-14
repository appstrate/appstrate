// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { cn } from "@appstrate/ui/cn";
import type { OrgLogo } from "../lib/org-logo";

export function OrganizationAvatar({
  org,
  className,
}: {
  org: { name: string; logo?: OrgLogo | null };
  className?: string;
}) {
  const { logo } = org;
  const emoji = logo?.kind === "emoji" ? logo.emoji : null;
  const image = logo?.kind === "image" ? logo.url : null;
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
