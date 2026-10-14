// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon, loadIcon } from "@iconify/react";
import { Puzzle } from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import { parseManifestIcon, type ManifestIcon } from "@appstrate/core/manifest-icon";
import type { PackageType } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { isLucideIconName, resolveAgentIdentity } from "./agent-identity-options";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";

const BOX = { sm: "size-7 rounded-md", md: "size-10 rounded-[10px]" } as const;

type PackageIconSize = keyof typeof BOX;

function Skeleton({ className }: { className: string }) {
  return <span className={cn("bg-muted block animate-pulse", className)} aria-hidden />;
}

/**
 * An Iconify id other than a Lucide one. The SVG is fetched from the Iconify
 * API the first time an id is seen; React Query dedupes that fetch across every
 * tile and keeps it for the session.
 */
function IconifyGlyph({
  id,
  className,
  fallback,
}: {
  id: string;
  className: string;
  fallback: ReactNode;
}) {
  const { isPending, isError } = useQuery({
    queryKey: ["iconify-icon", id],
    queryFn: () => loadIcon(id),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  if (isPending) return <Skeleton className={className} />;
  if (isError) return fallback;
  return <Icon icon={id} className={className} />;
}

function UrlGlyph({
  src,
  className,
  fallback,
}: {
  src: string;
  className: string;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") return fallback;
  return (
    <>
      {state === "loading" && <Skeleton className={className} />}
      <img
        src={src}
        alt=""
        className={cn(className, "object-contain", state !== "ok" && "hidden")}
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
      />
    </>
  );
}

/** A manifest icon: Lucide from the bundle, any other Iconify id from the API, an URL as an image. */
function ManifestGlyph({
  icon,
  className,
  fallback,
  strokeWidth,
}: {
  icon: ManifestIcon;
  className: string;
  fallback: ReactNode;
  strokeWidth?: number;
}) {
  if (icon.kind === "lucide") {
    return isLucideIconName(icon.name) ? (
      <DynamicIcon name={icon.name} className={className} strokeWidth={strokeWidth} />
    ) : (
      fallback
    );
  }
  if (icon.kind === "iconify")
    return <IconifyGlyph id={icon.id} className={className} fallback={fallback} />;
  return <UrlGlyph src={icon.src} className={className} fallback={fallback} />;
}

/**
 * A package's identity tile, the same for every type and surface. Its manifest
 * `icon` follows one grammar for every type (`@appstrate/core/manifest-icon`):
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
    const parsed = parseManifestIcon(icon);
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
