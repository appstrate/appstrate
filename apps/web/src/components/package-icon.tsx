// SPDX-License-Identifier: Apache-2.0

import { Puzzle } from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import { parseIcon } from "@appstrate/core/appearance";
import type { PackageType } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { ManifestGlyph } from "@appstrate/ui/components/manifest-glyph";
import { resolveAgentIdentity } from "./agent-identity-options";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";

const BOX = { sm: "size-7 rounded-md", md: "size-10 rounded-[10px]" } as const;

type PackageIconSize = keyof typeof BOX;

/**
 * A package's identity tile, the same for every type and surface. Its manifest
 * `icon` follows one grammar for every type (`@appstrate/core/appearance`):
 * an agent draws it on its chosen colour (`lucide:bot` when it has none), an
 * integration as its logo (a neutral placeholder when it has none), the other
 * types show their type's glyph on a muted ground.
 */
export function PackageIcon({
  type,
  icon,
  color,
  size = "md",
  className,
  iconClassName,
}: {
  type: PackageType;
  icon?: string | null;
  color?: string | null;
  size?: PackageIconSize;
  className?: string;
  iconClassName?: string;
}) {
  const box = cn(BOX[size], className);
  const muted = cn("bg-muted text-muted-foreground flex shrink-0 items-center justify-center", box);
  const mutedGlyph = cn(size === "sm" ? "size-4" : "size-5", iconClassName);

  if (type === "agent") {
    const identity = resolveAgentIdentity(icon, color);
    const glyph = cn("size-[18px]", iconClassName);
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          identity.tintClassName,
          box,
        )}
        style={
          identity.customColor
            ? { backgroundColor: `${identity.customColor}1f`, color: identity.customColor }
            : undefined
        }
        aria-hidden
      >
        <ManifestGlyph
          icon={identity.icon}
          className={glyph}
          strokeWidth={1.8}
          fallback={<DynamicIcon name="bot" className={glyph} strokeWidth={1.8} />}
        />
      </span>
    );
  }

  if (type === "integration") {
    const placeholder = (
      <span className={muted} aria-hidden>
        <Puzzle className={mutedGlyph} />
      </span>
    );
    const parsed = parseIcon(icon);
    if (!parsed) return placeholder;
    return (
      <ManifestGlyph
        icon={parsed}
        className={cn("shrink-0", box, size === "sm" ? "p-1" : "p-1.5")}
        fallback={placeholder}
      />
    );
  }

  const Glyph = PACKAGE_TYPE_ICON[type];
  return (
    <span className={muted} aria-hidden>
      <Glyph className={mutedGlyph} />
    </span>
  );
}
