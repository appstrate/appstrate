// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/shared-types";

/**
 * /agents/{id} or /{type}s/{id} — the SPA's pages sit under the same segment
 * as the type's API routes (`PACKAGE_TYPE_ROUTE_SEGMENT`), so there is one
 * type→segment map for both, and it lives in core.
 *
 * Total over an arbitrary string because one caller's type comes from a
 * notification's jsonb payload rather than from the typed client: an unknown
 * type lands on the agent list instead of rendering `/undefined/…`.
 */
export function packageDetailPath(type: PackageType | string, packageId: string): string {
  return `/${PACKAGE_TYPE_ROUTE_SEGMENT[type as PackageType] ?? "agents"}/${packageId}`;
}

/** /agents for agents, /{type}s for others */
export function packageListPath(type: PackageType | string): string {
  return `/${PACKAGE_TYPE_ROUTE_SEGMENT[type as PackageType]}`;
}

/** /{type}s/{id}/edit */
export function packageEditPath(type: PackageType | string, packageId: string): string {
  return `${packageDetailPath(type, packageId)}/edit`;
}

/** /{type}s/new */
export function packageNewPath(type: PackageType | string): string {
  return `/${PACKAGE_TYPE_ROUTE_SEGMENT[type as PackageType]}/new`;
}

/**
 * Split a package id (`@scope/name`) into the typed client's `{scope}`/`{name}`
 * path params. The scope keeps its leading `@` — the client's pathSerializer
 * sends it literally, matching the API's `:scope{@[^/]+}` routes.
 */
export function splitPackageRef(packageId: string): { scope: string; name: string } {
  const slash = packageId.indexOf("/");
  return { scope: packageId.slice(0, slash), name: packageId.slice(slash + 1) };
}
