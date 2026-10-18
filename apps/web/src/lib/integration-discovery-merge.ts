// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/schema";

export type DiscoveryProposal =
  paths["/api/integrations/discover"]["post"]["responses"][200]["content"]["application/json"];

type Manifest = Record<string, unknown>;
export type DiscoveryBadges = Record<string, "detected" | "guessed">;

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Top-level manifest fields a proposal fills when the author has not touched them. */
const FILLABLE = ["display_name", "name", "documentation", "privacy_policies", "icon"] as const;

/**
 * Applies a discovery proposal over the author's draft. A field is overwritten only when it is
 * still empty or still the creation skeleton (`defaults`); `source.remote` always follows the
 * analysed URL. `badges` keeps the provenance of the fields actually applied.
 */
export function mergeDiscovery(
  current: Manifest,
  defaults: Manifest,
  proposal: Pick<DiscoveryProposal, "manifest" | "provenance">,
): { manifest: Manifest; badges: DiscoveryBadges } {
  const proposed: Manifest = proposal.manifest;
  const manifest: Manifest = { ...current };
  const badges: DiscoveryBadges = {};
  const badge = (pointer: string) => {
    const provenance = proposal.provenance[pointer];
    if (provenance) badges[pointer] = provenance;
  };

  for (const key of FILLABLE) {
    if (proposed[key] === undefined) continue;
    if (isEmpty(current[key]) || isDeepEqual(current[key], defaults[key])) {
      manifest[key] = proposed[key];
      badge(`/${key}`);
    }
  }

  if (isEmpty(current.auths) || isDeepEqual(current.auths, defaults.auths)) {
    manifest.auths = proposed.auths;
    for (const pointer of Object.keys(proposal.provenance)) {
      if (pointer.startsWith("/auths/")) badge(pointer);
    }
  }

  const remote = proposal.manifest.source.remote;
  const currentSource = asRecord(current.source);
  const currentRemote = asRecord(currentSource.remote);
  manifest.source = {
    ...currentSource,
    kind: "remote",
    remote: {
      ...currentRemote,
      url: currentRemote.url === remote.url ? currentRemote.url : remote.url,
      transport: remote.transport,
    },
  };
  badge("/source/remote/transport");

  return { manifest, badges };
}

/** Structural equality over JSON values, blind to key order. */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) =>
    isDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function asRecord(v: unknown): Manifest {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Manifest) : {};
}

/** The provenance of the first applied badge under `prefix` (`/auths` covers `/auths/oauth`). */
export function badgeUnder(
  badges: DiscoveryBadges,
  prefix: string,
): DiscoveryBadges[string] | undefined {
  const pointer = Object.keys(badges).find((p) => p === prefix || p.startsWith(`${prefix}/`));
  return pointer ? badges[pointer] : undefined;
}
