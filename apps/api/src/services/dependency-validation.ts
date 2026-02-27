/**
 * Dependency validation — validates that all required services are connected before execution.
 * Shared by executions.ts, share.ts, and scheduler.ts.
 */

import { getConnectionStatus, validateScopes } from "./connection-manager.ts";
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
 * serviceProfiles maps serviceId → profileId.
 * Returns null if all deps are OK, or a DependencyError describing the first failure.
 */
export async function validateFlowDependencies(
  services: FlowServiceRequirement[],
  serviceProfiles: Record<string, string>,
  orgId: string,
): Promise<DependencyError | null> {
  // Check for missing profiles first (no async needed)
  for (const svc of services) {
    const profileId = serviceProfiles[svc.id];
    if (!profileId) {
      const mode = svc.connectionMode ?? "user";
      if (mode === "admin") {
        return {
          error: "DEPENDENCY_NOT_SATISFIED",
          message: `Service '${svc.id}' is not bound by an administrator`,
          serviceId: svc.id,
        };
      }
      return {
        error: "DEPENDENCY_NOT_SATISFIED",
        message: `Service '${svc.id}' is not connected`,
        serviceId: svc.id,
        connectUrl: `/auth/connect/${svc.provider}`,
      };
    }
  }

  // Fetch all connection statuses in parallel (all services have profiles at this point)
  const statuses = await Promise.all(
    services.map((svc) => getConnectionStatus(svc.provider, serviceProfiles[svc.id]!, orgId)),
  );

  for (let i = 0; i < services.length; i++) {
    const svc = services[i]!;
    const conn = statuses[i]!;

    if (conn.status === "not_connected") {
      return {
        error: "DEPENDENCY_NOT_SATISFIED",
        message: `Service '${svc.id}' is not connected`,
        serviceId: svc.id,
        connectUrl: `/auth/connect/${svc.provider}`,
      };
    }

    if (conn.status === "needs_reconnection") {
      return {
        error: "NEEDS_RECONNECTION",
        message: `Service '${svc.id}' needs to be reconnected (provider configuration changed)`,
        serviceId: svc.id,
        connectUrl: `/auth/connect/${svc.provider}`,
      };
    }

    if (svc.scopes && svc.scopes.length > 0 && conn.scopesGranted) {
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

  return null;
}
