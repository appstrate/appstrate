// SPDX-License-Identifier: Apache-2.0

import { useState, type ComponentType, type SVGAttributes } from "react";
import { cn } from "@/lib/utils";

/* ── react-icons: tree-shaken per-icon imports ────────────────────────── */
import {
  SiBrevo,
  SiCalendly,
  SiCanva,
  SiClickup,
  SiDiscord,
  SiDropbox,
  SiGithub,
  SiGmail,
  SiGoogle,
  SiGooglecalendar,
  SiGoogledrive,
  SiGoogleforms,
  SiGooglesheets,
  SiHubspot,
  SiIntercom,
  SiKit,
  SiLoom,
  SiMailchimp,
  SiNotion,
  SiPaypal,
  SiPinterest,
  SiQuickbooks,
  SiReddit,
  SiShopify,
  SiSlack,
  SiStripe,
  SiTelegram,
  SiTrello,
  SiTwilio,
  SiTypeform,
  SiWoocommerce,
  SiWordpress,
  SiX,
  SiXero,
  SiYoutube,
  SiZoom,
} from "react-icons/si";
import { FaLinkedin, FaMicrosoft } from "react-icons/fa6";
import { TbWebhook } from "react-icons/tb";

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
  calendly: { icon: SiCalendly, color: "#006BFF" },
  canva: { icon: SiCanva, color: "#00C4CC" },
  clickup: { icon: SiClickup, color: "#7B68EE" },
  discord: { icon: SiDiscord, color: "#5865F2" },
  dropbox: { icon: SiDropbox, color: "#0061FF" },
  github: { icon: SiGithub, color: "#181717", darkInvert: true },
  gmail: { icon: SiGmail, color: "#EA4335" },
  googlecalendar: { icon: SiGooglecalendar, color: "#4285F4" },
  googlecontacts: { icon: SiGoogle, color: "#4285F4" },
  googledrive: { icon: SiGoogledrive, color: "#4285F4" },
  googleforms: { icon: SiGoogleforms, color: "#7248B9" },
  googlesheets: { icon: SiGooglesheets, color: "#34A853" },
  hubspot: { icon: SiHubspot, color: "#FF7A59" },
  intercom: { icon: SiIntercom, color: "#1F8DED" },
  kit: { icon: SiKit, color: "#FB6970" },
  linkedin: { icon: FaLinkedin, color: "#0A66C2" },
  loom: { icon: SiLoom, color: "#625DF5" },
  mailchimp: { icon: SiMailchimp, color: "#FFE01B", darkInvert: true },
  microsoftonedrive: { icon: FaMicrosoft, color: "#0078D4" },
  microsoftoutlook: { icon: FaMicrosoft, color: "#0078D4" },
  microsoftteams: { icon: FaMicrosoft, color: "#4B53BC" },
  notion: { icon: SiNotion, color: "#000000", darkInvert: true },
  paypal: { icon: SiPaypal, color: "#003087" },
  pinterest: { icon: SiPinterest, color: "#BD081C" },
  quickbooks: { icon: SiQuickbooks, color: "#2CA01C" },
  reddit: { icon: SiReddit, color: "#FF4500" },
  shopify: { icon: SiShopify, color: "#7AB55C" },
  slack: { icon: SiSlack, color: "#4A154B" },
  stripe: { icon: SiStripe, color: "#635BFF" },
  telegram: { icon: SiTelegram, color: "#26A5E4" },
  trello: { icon: SiTrello, color: "#0052CC" },
  twilio: { icon: SiTwilio, color: "#F22F46" },
  typeform: { icon: SiTypeform, color: "#262627", darkInvert: true },
  webhook: { icon: TbWebhook, color: "#6B7280" },
  woo: { icon: SiWoocommerce, color: "#96588A" },
  wordpress: { icon: SiWordpress, color: "#21759B" },
  x: { icon: SiX, color: "#000000", darkInvert: true },
  xero: { icon: SiXero, color: "#13B5EA" },
  youtube: { icon: SiYoutube, color: "#FF0000" },
  zoom: { icon: SiZoom, color: "#0B5CFF" },
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
