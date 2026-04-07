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
  /** Brand hex color (light theme). */
  color: string;
  /** If true the color is too dark on dark backgrounds — use white in dark mode. */
  darkInvert?: boolean;
}

/**
 * Map from icon key → local react-icons component + brand color.
 * Add entries here when new system providers are added.
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

const ICON_BASE =
  "bg-muted/50 dark:bg-muted/50 shrink-0 rounded object-contain p-1 " +
  "drop-shadow-[0_0_0.5px_rgba(0,0,0,0.5)] dark:drop-shadow-[0_0_0.5px_rgba(255,255,255,0.6)]";

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:");
}

interface ProviderIconProps {
  src: string;
  alt?: string;
  className?: string;
}

/**
 * Renders a provider icon.
 *
 * Resolution order:
 * 1. If src is a key (not a URL), look up in ICON_MAP → local SVG
 * 2. If src is a URL, render remote `<img>`
 * 3. Letter avatar fallback on error or unknown key
 */
export function ProviderIcon({ src, alt = "", className }: ProviderIconProps) {
  if (!isUrl(src)) {
    const entry = ICON_MAP[src];
    if (entry) {
      return (
        <entry.icon
          aria-label={alt || src}
          style={{ color: entry.color }}
          className={cn(ICON_BASE, entry.darkInvert && "dark:[color:white]", className)}
        />
      );
    }
    // Unknown key — letter fallback
    const label = alt || src;
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

  return <RemoteIcon src={src} alt={alt} className={className} />;
}

/** Remote image that falls back to a letter avatar on error. */
function RemoteIcon({ src, alt, className }: ProviderIconProps) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    const label = alt || "?";
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
