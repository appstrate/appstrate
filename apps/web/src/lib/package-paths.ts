import type { PackageType } from "../hooks/use-packages";

/** /flows/{id} or /{type}s/{id} */
export function packageDetailPath(type: PackageType | string, packageId: string): string {
  return type === "flow" ? `/flows/${packageId}` : `/${type}s/${packageId}`;
}

/** / for flows, /{type}s for others */
export function packageListPath(type: PackageType | string): string {
  return type === "flow" ? "/flows" : `/${type}s`;
}

/** /{type}s/{id}/edit */
export function packageEditPath(type: PackageType | string, packageId: string): string {
  return `${packageDetailPath(type, packageId)}/edit`;
}

/** /{type}s/new */
export function packageNewPath(type: PackageType | string): string {
  return `/${type}s/new`;
}
