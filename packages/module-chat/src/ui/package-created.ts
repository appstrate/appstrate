// SPDX-License-Identifier: Apache-2.0

/**
 * The package a chat tool call created, read from its result: a type's create
 * operation through `invoke_operation`, or `import_package_file`. The chat
 * links it the way the editor and the import dialog open what they made, so a
 * package written by the assistant is one click away whatever its type.
 */

import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { packageTypeEnum, type PackageType } from "@appstrate/core/validation";
import { asRecordOrNull } from "@appstrate/core/safe-json";

/** The create operation of each package type, as the MCP catalog names it. */
const CREATE_OPERATIONS: Readonly<Record<string, PackageType>> = {
  createAgent: "agent",
  createSkill: "skill",
  createIntegrationPackage: "integration",
  createMcpServerPackage: "mcp-server",
};

export interface CreatedPackage {
  packageId: string;
  type: PackageType;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** `invoke_operation`: a create operation's 201 body names the package by `id`. */
export function packageCreatedByOperation(
  operationId: string,
  unwrapped: unknown,
): CreatedPackage | null {
  const type = CREATE_OPERATIONS[operationId];
  if (!type) return null;
  const record = asRecordOrNull(unwrapped);
  const packageId = nonEmpty(asRecordOrNull(record?.body)?.id);
  return packageId ? { packageId, type } : null;
}

/** `import_package_file`: the bundle import names its root and the root's type. */
export function packageCreatedByImport(unwrapped: unknown): CreatedPackage | null {
  const record = asRecordOrNull(unwrapped);
  const packageId = nonEmpty(record?.root_package_id);
  const type = packageTypeEnum.safeParse(record?.root_type);
  return packageId && type.success ? { packageId, type: type.data } : null;
}

/** The package's page in the app; `@scope/name` keeps its slash, as every app route does. */
export function packagePageHref({ packageId, type }: CreatedPackage): string {
  return `/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/${packageId}`;
}
