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

export interface ChatSkill {
  package_id: string;
  display_name: string;
  description: string;
  /** The skill's own manifest version, when known — pin a `dependencies.skills`
   * range from it. */
  version: string | null;
  source: string;
}

export interface ChatSkillsService {
  listInstalled(args: { orgId: string; applicationId: string; limit?: number }): Promise<{
    skills: ChatSkill[];
    truncated: boolean;
    total: number;
  }>;
}

export interface ChatRecentRun {
  package_id: string;
  status: string;
  run_number?: number | null;
  started_at?: string | null;
  /** Failure message for non-success runs, when available. */
  error?: string | null;
}

export interface ChatRunsService {
  /** The caller's own recent runs (actor-scoped), newest first. */
  listRecentForActor(args: {
    orgId: string;
    applicationId: string;
    actor: { type: "user" | "end_user"; id: string };
    limit?: number;
  }): Promise<ChatRecentRun[]>;
}

export interface ChatInProcessService {
  dispatch(request: Request): Promise<Response>;
}

let integrationsService: ChatIntegrationsService | null = null;
let agentsService: ChatAgentsService | null = null;
let skillsService: ChatSkillsService | null = null;
let runsService: ChatRunsService | null = null;
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

export function setSkillsService(svc: ChatSkillsService | null): void {
  skillsService = svc;
}

export function getSkillsService(): ChatSkillsService | null {
  return skillsService;
}

export function setRunsService(svc: ChatRunsService | null): void {
  runsService = svc;
}

export function getRunsService(): ChatRunsService | null {
  return runsService;
}

export function setInProcessService(svc: ChatInProcessService | null): void {
  inProcessService = svc;
}

export function getInProcessService(): ChatInProcessService | null {
  return inProcessService;
}
