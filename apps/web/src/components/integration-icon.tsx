// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon, loadIcon } from "@iconify/react";
import { Puzzle } from "lucide-react";

const BOX = "size-10 shrink-0 rounded-md";

function PlaceholderIcon() {
  return (
    <div className={`bg-muted text-muted-foreground flex items-center justify-center ${BOX}`}>
      <Puzzle size={20} />
    </div>
  );
}

function SkeletonIcon() {
  return <div className={`bg-muted animate-pulse ${BOX}`} aria-hidden="true" />;
}

/**
 * Iconify-backed logo. The SVG is fetched on demand from the Iconify API the
 * first time an id is seen; React Query owns that async state (dedupes the same
 * id across every card, caches the result for the session). Skeleton while in
 * flight, the icon once resolved, the neutral placeholder when the id resolves
 * to nothing.
 */
function IconifyIcon({ id }: { id: string }) {
  const { isPending, isError } = useQuery({
    queryKey: ["iconify-icon", id],
    queryFn: () => loadIcon(id),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  if (isPending) return <SkeletonIcon />;
  if (isError) return <PlaceholderIcon />;
  return <Icon icon={id} className={`${BOX} p-1.5`} />;
}

function UrlIcon({ src }: { src: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") return <PlaceholderIcon />;
  return (
    <>
      {state === "loading" && <SkeletonIcon />}
      <img
        src={src}
        alt=""
        className={`${BOX} object-contain ${state === "ok" ? "" : "hidden"}`}
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
export function IntegrationIcon({ src }: { src?: string }) {
  if (!src) return <PlaceholderIcon />;
  const isUrl = /^(https?:)?\/\//.test(src) || src.startsWith("data:");
  return isUrl ? <UrlIcon src={src} /> : <IconifyIcon id={src} />;
}
