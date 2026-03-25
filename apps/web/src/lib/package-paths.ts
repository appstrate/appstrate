import { PACKAGE_CONFIG, type PackageType } from "../hooks/use-packages";

/** /flows/{id} or /{type}s/{id} */
export function packageDetailPath(type: PackageType | string, packageId: string): string {
  return `/${PACKAGE_CONFIG[type as PackageType].path}/${packageId}`;
}

/** /flows for flows, /{type}s for others */
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
