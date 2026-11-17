// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/shared-types";

/**
 * /{type}s/{id}, same segment as the API routes (`PACKAGE_TYPE_ROUTE_SEGMENT`).
 * Total over any string (a notification's jsonb payload type): unknown → `/agents`,
 * not `/undefined/…`.
 */
export function packageDetailPath(type: PackageType | string, packageId: string): string {
  return `/${PACKAGE_TYPE_ROUTE_SEGMENT[type as PackageType] ?? "agents"}/${packageId}`;
}

export function packageListPath(type: PackageType | string): string {
  return `/${PACKAGE_TYPE_ROUTE_SEGMENT[type as PackageType]}`;
}

export function runDetailPath(packageId: string, runId: string): string {
  return `${packageDetailPath("agent", packageId)}/runs/${runId}`;
}

export function scheduleDetailPath(scheduleId: string): string {
  return `/schedules/${scheduleId}`;
}

/** Split `@scope/name` into the client's path params; the scope keeps its `@` (matches the API's `:scope{@[^/]+}` routes). */
export function splitPackageRef(packageId: string): { scope: string; name: string } {
  const slash = packageId.indexOf("/");
  return { scope: packageId.slice(0, slash), name: packageId.slice(slash + 1) };
}
