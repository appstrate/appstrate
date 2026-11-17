// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from "react";
import { Icon, iconLoaded, loadIcon } from "@iconify/react";
import { DynamicIcon } from "lucide-react/dynamic";
import type { AppearanceIcon } from "@appstrate/core/appearance";
import { cn } from "../cn.ts";
import { isLucideName } from "../lucide-names.ts";

type LoadState = "loading" | "ok" | "error";

/** Loading placeholder; a `span` so it is valid inside buttons, spans and paragraphs. */
function GlyphSkeleton({ className }: { className: string }) {
  return <span className={cn("bg-muted block animate-pulse", className)} aria-hidden />;
}

/**
 * An Iconify id other than a Lucide one. The SVG is fetched from the Iconify
 * API the first time an id is seen and cached by Iconify for the session, so a
 * second tile with the same id draws at once.
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
  const [state, setState] = useState<LoadState>(iconLoaded(id) ? "ok" : "loading");
  useEffect(() => {
    if (iconLoaded(id)) return;
    let live = true;
    loadIcon(id).then(
      () => live && setState("ok"),
      () => live && setState("error"),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (state === "loading") return <GlyphSkeleton className={className} />;
  if (state === "error") return fallback;
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
  const [state, setState] = useState<LoadState>("loading");
  if (state === "error") return fallback;
  return (
    <>
      {state === "loading" && <GlyphSkeleton className={className} />}
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

/**
 * An icon (`parseIcon`): Lucide from the bundle, any other Iconify id from the
 * API, an URL as an image, an emoji as text. `fallback` stands in when the
 * glyph cannot be drawn: an unknown Lucide name, a failed Iconify fetch, a
 * broken image. Not passed to `DynamicIcon`: it would show it while the Lucide
 * chunk loads, a flash of initials on every tile.
 */
export function ManifestGlyph({
  icon,
  className,
  fallback,
  strokeWidth,
}: {
  icon: AppearanceIcon;
  className: string;
  fallback: ReactNode;
  strokeWidth?: number;
}) {
  if (icon.kind === "lucide") {
    return isLucideName(icon.name) ? (
      <DynamicIcon name={icon.name} className={className} strokeWidth={strokeWidth} />
    ) : (
      fallback
    );
  }
  if (icon.kind === "iconify")
    return <IconifyGlyph key={icon.id} id={icon.id} className={className} fallback={fallback} />;
  if (icon.kind === "emoji")
    return (
      <span className={cn("leading-none", className)} aria-hidden>
        {icon.emoji}
      </span>
    );
  return <UrlGlyph src={icon.src} className={className} fallback={fallback} />;
}
