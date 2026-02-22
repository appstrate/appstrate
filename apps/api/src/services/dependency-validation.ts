/**
 * Dependency validation — validates that all required services are connected before execution.
 * Shared by executions.ts, share.ts, and scheduler.ts.
 */

import { listUserConnections, getConnectionStatus, validateScopes } from "./connection-manager.ts";
import type { FlowServiceRequirement } from "../types/index.ts";

export interface DependencyError {
  error: string;
  message: string;
  serviceId: string;
  connectUrl?: string;
  details?: Record<string, unknown>;
}

/**
 * Validate that all required service dependencies are satisfied.
 * Returns null if all deps are OK, or a DependencyError describing the first failure.
 */
export async function validateFlowDependencies(
  services: FlowServiceRequirement[],
  adminConns: Record<string, string>,
  orgId: string,
  userId: string,
): Promise<DependencyError | null> {
  const connections = await listUserConnections(orgId, userId);
  const connectedProviders = new Set(connections.map((c) => c.provider));

  for (const svc of services) {
    const mode = svc.connectionMode ?? "user";

    if (mode === "admin") {
      const adminUserId = adminConns[svc.id];
      if (!adminUserId) {
        return {
          error: "DEPENDENCY_NOT_SATISFIED",
          message: `Service '${svc.id}' is not bound by an administrator`,
          serviceId: svc.id,
        };
      }
      const conn = await getConnectionStatus(svc.provider, orgId, adminUserId);
      if (conn.status !== "connected") {
        return {
          error: "DEPENDENCY_NOT_SATISFIED",
          message: `Admin connection for '${svc.id}' is no longer active`,
          serviceId: svc.id,
        };
      }
    } else {
      if (!connectedProviders.has(svc.provider)) {
        return {
          error: "DEPENDENCY_NOT_SATISFIED",
          message: `Service '${svc.id}' is not connected`,
          serviceId: svc.id,
          connectUrl: `/auth/connect/${svc.provider}`,
        };
      }
    }

    // Scope validation: check that granted scopes satisfy required scopes
    if (svc.scopes && svc.scopes.length > 0) {
      const effectiveUserId = mode === "admin" ? adminConns[svc.id] : userId;
      if (effectiveUserId) {
        const conn = await getConnectionStatus(svc.provider, orgId, effectiveUserId);
        if (conn.status === "connected" && conn.scopesGranted) {
          const scopeResult = validateScopes(conn.scopesGranted, svc.scopes);
          if (!scopeResult.sufficient) {
            return {
              error: "SCOPE_INSUFFICIENT",
              message: `Service '${svc.id}' requires additional permissions`,
              serviceId: svc.id,
              details: {
                serviceId: svc.id,
                provider: svc.provider,
                missing: scopeResult.missing,
                granted: scopeResult.granted,
              },
            };
          }
        }
      }
    }
  }

  return null;
}
