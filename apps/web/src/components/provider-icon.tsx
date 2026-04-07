// SPDX-License-Identifier: Apache-2.0

import { useState, type ComponentType, type SVGAttributes } from "react";
import { cn } from "@/lib/utils";

/* ── react-icons: tree-shaken per-icon imports ────────────────────────── */
import {
  SiBrevo,
  SiClickup,
  SiDiscord,
  SiGithub,
  SiGmail,
  SiGoogledrive,
  SiGooglesheets,
  SiHubspot,
  SiNotion,
  SiPinterest,
  SiReddit,
  SiSlack,
  SiStripe,
  SiTrello,
  SiX,
  SiYoutube,
} from "react-icons/si";
import { FaLinkedin } from "react-icons/fa6";

type IconComponent = ComponentType<SVGAttributes<SVGElement>>;

interface IconEntry {
  icon: IconComponent;
  /** Brand hex color (light theme). Icons with very dark colors get swapped in dark mode. */
  color: string;
  /** If true the color is too dark to read on dark backgrounds — use white in dark mode. */
  darkInvert?: boolean;
}

/**
 * Map from `cdn.simpleicons.org` slug → local react-icons component + brand color.
 * Only icons actually used by system providers need to be listed.
 * Add entries here when new providers are added.
 */
const ICON_MAP: Record<string, IconEntry> = {
  brevo: { icon: SiBrevo, color: "#0B996E" },
  clickup: { icon: SiClickup, color: "#7B68EE" },
  discord: { icon: SiDiscord, color: "#5865F2" },
  github: { icon: SiGithub, color: "#181717", darkInvert: true },
  gmail: { icon: SiGmail, color: "#EA4335" },
  googledrive: { icon: SiGoogledrive, color: "#4285F4" },
  googlesheets: { icon: SiGooglesheets, color: "#34A853" },
  hubspot: { icon: SiHubspot, color: "#FF7A59" },
  linkedin: { icon: FaLinkedin, color: "#0A66C2" },
  notion: { icon: SiNotion, color: "#000000", darkInvert: true },
  pinterest: { icon: SiPinterest, color: "#BD081C" },
  reddit: { icon: SiReddit, color: "#FF4500" },
  slack: { icon: SiSlack, color: "#4A154B" },
  stripe: { icon: SiStripe, color: "#635BFF" },
  trello: { icon: SiTrello, color: "#0052CC" },
  x: { icon: SiX, color: "#000000", darkInvert: true },
  youtube: { icon: SiYoutube, color: "#FF0000" },
};

/* ── Helpers ──────────────────────────────────────────────────────────── */

const SIMPLEICONS_CDN = "cdn.simpleicons.org";

/** Shared base classes for all icon variants (local SVG, remote img, letter fallback). */
const ICON_BASE =
  "bg-muted/50 dark:bg-muted/50 shrink-0 rounded object-contain p-1 " +
  "drop-shadow-[0_0_0.5px_rgba(0,0,0,0.5)] dark:drop-shadow-[0_0_0.5px_rgba(255,255,255,0.6)]";

/** Extract slug from `https://cdn.simpleicons.org/{slug}[/{color}]`. */
function extractSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== SIMPLEICONS_CDN) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

/* ── Component ────────────────────────────────────────────────────────── */

interface ProviderIconProps {
  src: string;
  alt?: string;
  className?: string;
}

/**
 * Renders a provider icon.
 *
 * Resolution order:
 * 1. Local react-icons component (if src matches a known simpleicons CDN slug)
 * 2. Remote `<img>` from the original URL
 * 3. Letter avatar fallback on load error
 */
export function ProviderIcon({ src, alt = "", className }: ProviderIconProps) {
  const slug = extractSlug(src);
  const LocalIcon = slug ? ICON_MAP[slug] : undefined;

  // ── 1. Local icon ──
  if (LocalIcon) {
    return (
      <LocalIcon.icon
        aria-label={alt || slug || ""}
        style={{ color: LocalIcon.color }}
        className={cn(ICON_BASE, LocalIcon.darkInvert && "dark:[color:white]", className)}
      />
    );
  }

  // ── 2. Remote image with error fallback ──
  return <RemoteIcon src={src} alt={alt} className={className} />;
}

/** Remote image that falls back to a letter avatar on error. */
function RemoteIcon({ src, alt, className }: ProviderIconProps) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    const label = alt || extractSlug(src) || "?";
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "bg-muted/50 dark:bg-muted/50 text-muted-foreground shrink-0 rounded",
          "inline-flex items-center justify-center text-xs font-medium",
          className,
        )}
      >
        {label.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setErrored(true)}
      className={cn(ICON_BASE, className)}
    />
  );
}
