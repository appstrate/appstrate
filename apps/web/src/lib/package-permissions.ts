// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import type { GateablePermission } from "../hooks/use-permissions";

/**
 * Per package family: the permission resource its own routes guard on, and the
 * permission that opens the install checkbox — the same table the API enforces
 * (`SPACE_PACKAGE_PERMISSION`, `routes/spaces.ts`). `agents:configure` rather
 * than `agents:write`: installing configures which space runs an agent, it does
 * not author one.
 */
export const PACKAGE_PERMISSIONS: Record<
  PackageType,
  { resource: string; install: GateablePermission }
> = {
  agent: { resource: "agents", install: "agents:configure" },
  skill: { resource: "skills", install: "skills:write" },
  "mcp-server": { resource: "mcp-servers", install: "mcp-servers:write" },
  integration: { resource: "integrations", install: "integrations:install" },
};
