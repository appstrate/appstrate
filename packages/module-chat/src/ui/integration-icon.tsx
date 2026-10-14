// SPDX-License-Identifier: Apache-2.0

/**
 * Small integration brand icon for the chat. `src` is a manifest `icon`, read
 * by `@appstrate/core/manifest-icon`: a Lucide id drawn from the bundle, any
 * other Iconify id fetched on demand from the Iconify API, or an image URL.
 * Falls back to a neutral puzzle glyph when absent or not drawable.
 * A trimmed-down sibling of apps/web's PackageIcon (module can't import web).
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon, loadIcon } from "@iconify/react";
import { PuzzleIcon } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { parseManifestIcon } from "@appstrate/core/manifest-icon";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";

const LUCIDE_NAMES = new Set<string>(iconNames);

function isLucideName(name: string): name is IconName {
  return LUCIDE_NAMES.has(name);
}

/** An Iconify id: the SVG is fetched once per id (deduped by React Query) — a bar until then. */
function IconifyGlyph({ id, className }: { id: string; className: string }) {
  const { isPending, isError } = useQuery({
    queryKey: ["iconify-icon", id],
    queryFn: () => loadIcon(id),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  if (isPending) return <Skeleton className={cn(className, "rounded-md")} aria-hidden />;
  if (isError) return <PuzzleIcon className={className} />;
  return <Icon icon={id} className={className} />;
}

function UrlGlyph({ src, className }: { src: string; className: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") return <PuzzleIcon className={className} />;
  return (
    <>
      {state === "loading" && <Skeleton className={cn(className, "rounded-md")} aria-hidden />}
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

export function IntegrationIcon({
  src,
  className = "size-4",
}: {
  src?: string;
  className?: string;
}) {
  const icon = parseManifestIcon(src);
  if (!icon) return <PuzzleIcon className={className} />;
  if (icon.kind === "url") {
    return <UrlGlyph src={icon.src} className={className} />;
  }
  if (icon.kind === "lucide") {
    return isLucideName(icon.name) ? (
      <DynamicIcon name={icon.name} className={className} />
    ) : (
      <PuzzleIcon className={className} />
    );
  }
  return <IconifyGlyph id={icon.id} className={className} />;
}
