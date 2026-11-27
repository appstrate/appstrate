// SPDX-License-Identifier: Apache-2.0

/**
 * The icon of each platform tool in `tools/list` (MCP `Tool.icons`): inline `data:` SVG, so a
 * client fetches nothing, one per theme. Shapes from Lucide (ISC licence, https://lucide.dev).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseIcon } from "@appstrate/core/appearance";
import type { PresentationIcon } from "@appstrate/core/mcp-presentation";
import type { McpToolName } from "./tools.ts";

const SHAPES = {
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  describe:
    '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
  invoke_operation:
    '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>',
  run_and_wait:
    '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  list_files:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  read: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  get_me:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  call_integration_tool:
    '<path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/>',
  import_package_file:
    '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  validate_package_file:
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m9 15 2 2 4-4"/>',
  get_runtime_capabilities:
    '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
} satisfies Record<McpToolName, string>;

function svgDataUri(shape: string, stroke: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** The icons of a platform tool, by name; `undefined` for a name no platform tool has. */
export function toolIcons(name: string): Tool["icons"] {
  if (!Object.hasOwn(SHAPES, name)) return undefined;
  const shape = SHAPES[name as McpToolName];
  return [
    {
      src: svgDataUri(shape, "#18181b"),
      mimeType: "image/svg+xml",
      sizes: ["any"],
      theme: "light",
    },
    { src: svgDataUri(shape, "#fafafa"), mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
  ];
}

/** Where the Iconify API serves one icon as an SVG file: the host a client's own Iconify loader asks. */
const ICONIFY_SVG_BASE = "https://api.iconify.design";

/**
 * A manifest `icon` (`parseIcon`'s grammar) as MCP icons a client draws from `src` alone: an image
 * URL or data URI as it is, an Iconify id as its SVG file on the Iconify API, an emoji as an inline
 * SVG. `undefined` for a value no surface can draw.
 */
export function manifestIcons(value: unknown): PresentationIcon[] | undefined {
  const icon = parseIcon(value);
  if (!icon) return undefined;
  switch (icon.kind) {
    case "url": {
      const mime = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(icon.src)?.[1];
      return [{ src: icon.src, ...(mime ? { mimeType: mime.toLowerCase() } : {}) }];
    }
    case "lucide":
      return [{ src: `${ICONIFY_SVG_BASE}/lucide/${icon.name}.svg`, mimeType: "image/svg+xml" }];
    case "iconify": {
      const [prefix, name] = icon.id.split(":");
      return [{ src: `${ICONIFY_SVG_BASE}/${prefix}/${name}.svg`, mimeType: "image/svg+xml" }];
    }
    case "emoji": {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="12" font-size="18" text-anchor="middle" dominant-baseline="central">${icon.emoji}</text></svg>`;
      return [
        {
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          mimeType: "image/svg+xml",
        },
      ];
    }
  }
}
