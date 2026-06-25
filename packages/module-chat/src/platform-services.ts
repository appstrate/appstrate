// SPDX-License-Identifier: Apache-2.0

/**
 * Injected platform capabilities (set by index.ts at module init from
 * `ctx.services`). They let the chat read the platform IN-PROCESS instead of
 * over a loopback HTTP hop:
 *
 *   - `integrations.listUsableForActor` replaces the `GET /api/me/context`
 *     round-trip used only to list the caller's connected integrations
 *     (identity + role come straight off the request context).
 *   - `inProcess.dispatch` re-enters the fully-wired platform Hono app without
 *     the socket hop (auth + RBAC still run on the dispatched Request).
 *
 * Both are OPTIONAL: before init, in tests, or on a platform that doesn't wire
 * them, the chat falls back to the loopback `fetch` it has always used. Mirrors
 * the `setRateLimitFactory` injection in routes.ts.
 */

export interface ChatIntegrationsService {
  listUsableForActor(args: {
    orgId: string;
    applicationId: string;
    actor: { type: "user" | "end_user"; id: string };
  }): Promise<
    Array<{
      integration_id: string;
      name: string;
      source: string;
      version?: string;
      /**
       * AFPS §4.4 `default_tools` — the tool(s) an agent inherits when it
       * declares the integration without an `integrations_configuration`
       * entry. Surfaced in the chat's caller context so the model knows
       * what it gets for free vs what it must select explicitly.
       */
      default_tools?: readonly string[] | "*";
    }>
  >;
}

export interface ChatRunnableAgent {
  package_id: string;
  display_name: string;
  description: string;
  takes_input: boolean;
  source: string;
}

export interface ChatAgentsService {
  listRunnable(args: { orgId: string; applicationId: string; limit?: number }): Promise<{
    agents: ChatRunnableAgent[];
    truncated: boolean;
    total: number;
  }>;
}

export interface ChatInProcessService {
  dispatch(request: Request): Promise<Response>;
}

let integrationsService: ChatIntegrationsService | null = null;
let agentsService: ChatAgentsService | null = null;
let inProcessService: ChatInProcessService | null = null;

export function setIntegrationsService(svc: ChatIntegrationsService | null): void {
  integrationsService = svc;
}

export function getIntegrationsService(): ChatIntegrationsService | null {
  return integrationsService;
}

export function setAgentsService(svc: ChatAgentsService | null): void {
  agentsService = svc;
}

export function getAgentsService(): ChatAgentsService | null {
  return agentsService;
}

export function setInProcessService(svc: ChatInProcessService | null): void {
  inProcessService = svc;
}

export function getInProcessService(): ChatInProcessService | null {
  return inProcessService;
}
