// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon, loadIcon } from "@iconify/react";
import { Puzzle } from "lucide-react";

const BOX = { sm: "size-7", md: "size-10" } as const;

type IntegrationIconSize = keyof typeof BOX;

function boxClass(size: IntegrationIconSize): string {
  return `${BOX[size]} shrink-0 rounded-md`;
}

function PlaceholderIcon({ size }: { size: IntegrationIconSize }) {
  return (
    <div
      className={`bg-muted text-muted-foreground flex items-center justify-center ${boxClass(size)}`}
    >
      <Puzzle className={size === "sm" ? "size-4" : "size-5"} />
    </div>
  );
}

function SkeletonIcon({ size }: { size: IntegrationIconSize }) {
  return <div className={`bg-muted animate-pulse ${boxClass(size)}`} aria-hidden="true" />;
}

/**
 * Iconify-backed logo. The SVG is fetched on demand from the Iconify API the
 * first time an id is seen; React Query owns that async state (dedupes the same
 * id across every card, caches the result for the session). Skeleton while in
 * flight, the icon once resolved, the neutral placeholder when the id resolves
 * to nothing.
 */
function IconifyIcon({ id, size }: { id: string; size: IntegrationIconSize }) {
  const { isPending, isError } = useQuery({
    queryKey: ["iconify-icon", id],
    queryFn: () => loadIcon(id),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  if (isPending) return <SkeletonIcon size={size} />;
  if (isError) return <PlaceholderIcon size={size} />;
  return <Icon icon={id} className={`${boxClass(size)} ${size === "sm" ? "p-1" : "p-1.5"}`} />;
}

function UrlIcon({ src, size }: { src: string; size: IntegrationIconSize }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") return <PlaceholderIcon size={size} />;
  return (
    <>
      {state === "loading" && <SkeletonIcon size={size} />}
      <img
        src={src}
        alt=""
        className={`${boxClass(size)} object-contain ${state === "ok" ? "" : "hidden"}`}
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
      />
    </>
  );
}

/**
 * Integration logo. AFPS manifests set `icon` to either an absolute image URL
 * or an Iconify icon id (e.g. "logos:slack-icon"). Both fetch over the network,
 * so a skeleton shows while loading and a neutral placeholder on failure or
 * when no `icon` is declared.
 */
export function IntegrationIcon({
  src,
  size = "md",
}: {
  src?: string;
  size?: IntegrationIconSize;
}) {
  if (!src) return <PlaceholderIcon size={size} />;
  const isUrl = /^(https?:)?\/\//.test(src) || src.startsWith("data:");
  return isUrl ? <UrlIcon src={src} size={size} /> : <IconifyIcon id={src} size={size} />;
}
