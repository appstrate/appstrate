import sql from "../db/client.ts";

export async function getFlowConfig(flowId: string): Promise<Record<string, unknown>> {
  const rows = await sql`SELECT config FROM flow_configs WHERE flow_id = ${flowId}`;
  return (rows[0]?.config as Record<string, unknown>) ?? {};
}

export async function setFlowConfig(flowId: string, config: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO flow_configs (flow_id, config, updated_at)
    VALUES (${flowId}, ${sql.json(config)}, NOW())
    ON CONFLICT (flow_id) DO UPDATE SET
      config = ${sql.json(config)},
      updated_at = NOW()
  `;
}

export async function getFlowState(flowId: string): Promise<Record<string, unknown>> {
  const rows = await sql`SELECT state FROM flow_state WHERE flow_id = ${flowId}`;
  return (rows[0]?.state as Record<string, unknown>) ?? {};
}

export async function setFlowState(flowId: string, state: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO flow_state (flow_id, state, updated_at)
    VALUES (${flowId}, ${sql.json(state)}, NOW())
    ON CONFLICT (flow_id) DO UPDATE SET
      state = ${sql.json(state)},
      updated_at = NOW()
  `;
}

export async function createExecution(id: string, flowId: string, input: Record<string, unknown> | null): Promise<void> {
  await sql`
    INSERT INTO executions (id, flow_id, status, input, started_at)
    VALUES (${id}, ${flowId}, 'pending', ${input ? sql.json(input) : null}, NOW())
  `;
}

export async function updateExecution(
  id: string,
  updates: {
    status?: string;
    result?: Record<string, unknown>;
    error?: string;
    tokens_used?: number;
    completed_at?: string;
    duration?: number;
  }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    sets.push("status");
    values.push(updates.status);
  }
  if (updates.result !== undefined) {
    sets.push("result");
  }
  if (updates.error !== undefined) {
    sets.push("error");
    values.push(updates.error);
  }

  // Use a simpler approach: update all fields at once
  await sql`
    UPDATE executions SET
      status = COALESCE(${updates.status ?? null}, status),
      result = COALESCE(${updates.result ? sql.json(updates.result) : null}, result),
      error = COALESCE(${updates.error ?? null}, error),
      tokens_used = COALESCE(${updates.tokens_used ?? null}, tokens_used),
      completed_at = COALESCE(${updates.completed_at ?? null}::timestamptz, completed_at),
      duration = COALESCE(${updates.duration ?? null}, duration)
    WHERE id = ${id}
  `;
}

export async function getExecution(id: string) {
  const rows = await sql`SELECT * FROM executions WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function getLastExecution(flowId: string) {
  const rows = await sql`
    SELECT * FROM executions
    WHERE flow_id = ${flowId}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
