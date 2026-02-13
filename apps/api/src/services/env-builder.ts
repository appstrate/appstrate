/**
 * Builds the environment variables map for a container execution.
 * Shared between manual runs (executions.ts) and scheduled runs (scheduler.ts).
 */
export function buildContainerEnv(params: {
  flowId: string;
  executionId: string;
  prompt: string;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  input?: Record<string, unknown>;
  skills?: { id: string; content: string }[];
}): Record<string, string> {
  const envVars: Record<string, string> = {
    FLOW_PROMPT: params.prompt,
    FLOW_ID: params.flowId,
    EXECUTION_ID: params.executionId,
    LLM_MODEL: process.env.LLM_MODEL || "claude-sonnet-4-5-20250929",
  };

  // Inject OAuth tokens (replace hyphens with underscores for valid env var names)
  for (const [svcId, token] of Object.entries(params.tokens)) {
    envVars[`TOKEN_${svcId.toUpperCase().replace(/-/g, "_")}`] = token;
  }

  // Inject config
  for (const [key, value] of Object.entries(params.config)) {
    envVars[`CONFIG_${key.toUpperCase()}`] = String(value);
  }

  // Inject state
  envVars["FLOW_STATE"] = JSON.stringify(params.state);

  // Inject input
  if (params.input) {
    for (const [key, value] of Object.entries(params.input)) {
      envVars[`INPUT_${key.toUpperCase()}`] = String(value);
    }
  }

  // Inject skills as JSON for container reconstruction
  if (params.skills && params.skills.length > 0) {
    envVars["FLOW_SKILLS"] = JSON.stringify(params.skills);
  }

  return envVars;
}
