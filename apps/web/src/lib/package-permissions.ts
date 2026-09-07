// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import type { CoreResource } from "@appstrate/core/permissions";
import type { GateablePermission } from "../hooks/use-permissions";

/**
 * Per package family: the permission resource its own routes guard on, and the
 * two space-installation grants — the same table the API enforces
 * (`spacePackagePermission`, `apps/api/src/lib/package-access.ts`).
 * `agents:configure` rather than `agents:write`: installing configures which
 * space runs an agent, it does not author one.
 */
export const PACKAGE_PERMISSIONS: Record<
  PackageType,
  { resource: CoreResource; install: GateablePermission; uninstall: GateablePermission }
> = {
  agent: { resource: "agents", install: "agents:configure", uninstall: "agents:configure" },
  skill: { resource: "skills", install: "skills:write", uninstall: "skills:write" },
  "mcp-server": {
    resource: "mcp-servers",
    install: "mcp-servers:write",
    uninstall: "mcp-servers:write",
  },
  integration: {
    resource: "integrations",
    install: "integrations:install",
    uninstall: "integrations:uninstall",
  },
};
