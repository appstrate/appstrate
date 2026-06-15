// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_CONFIG, type PackageType } from "../hooks/use-packages";

/** /agents/{id} or /{type}s/{id} */
export function packageDetailPath(type: PackageType | string, packageId: string): string {
  return `/${PACKAGE_CONFIG[type as PackageType].path}/${packageId}`;
}

/** /agents for agents, /{type}s for others */
export function packageListPath(type: PackageType | string): string {
  return `/${PACKAGE_CONFIG[type as PackageType].path}`;
}

/** /{type}s/{id}/edit */
export function packageEditPath(type: PackageType | string, packageId: string): string {
  return `${packageDetailPath(type, packageId)}/edit`;
}

/** /{type}s/new */
export function packageNewPath(type: PackageType | string): string {
  return `/${PACKAGE_CONFIG[type as PackageType].path}/new`;
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
