import sql from "../db/client.ts";
import type { ExecutionLog } from "../types/index.ts";

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

export async function getExecutionsByFlow(flowId: string, limit: number = 10) {
  const rows = await sql`
    SELECT id, flow_id, status, input, result, error, tokens_used, started_at, completed_at, duration
    FROM executions WHERE flow_id = ${flowId}
    ORDER BY started_at DESC LIMIT ${limit}
  `;
  return rows;
}

export async function appendExecutionLog(
  executionId: string,
  type: string,
  event: string | null,
  message: string | null,
  data: Record<string, unknown> | null
): Promise<number> {
  const rows = await sql`
    INSERT INTO execution_logs (execution_id, type, event, message, data)
    VALUES (${executionId}, ${type}, ${event}, ${message}, ${data ? sql.json(data) : null})
    RETURNING id
  `;
  return (rows[0]?.id ?? 0) as number;
}

export async function getExecutionLogs(
  executionId: string,
  afterId?: number,
  limit: number = 1000
): Promise<ExecutionLog[]> {
  const rows = await sql`
    SELECT id, execution_id, type, event, message, data, created_at
    FROM execution_logs
    WHERE execution_id = ${executionId}
      ${afterId !== undefined ? sql`AND id > ${afterId}` : sql``}
    ORDER BY id ASC LIMIT ${limit}
  `;
  return rows as unknown as ExecutionLog[];
}

export async function getRunningExecutionsForFlow(flowId: string): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS count FROM executions
    WHERE flow_id = ${flowId} AND status IN ('running', 'pending')
  `;
  return (rows[0]?.count ?? 0) as number;
}

export async function getRunningExecutionsCounts(): Promise<Record<string, number>> {
  const rows = await sql`
    SELECT flow_id, COUNT(*)::int AS count FROM executions
    WHERE status IN ('running', 'pending')
    GROUP BY flow_id
  `;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.flow_id as string] = row.count as number;
  }
  return counts;
}

export async function markOrphanExecutionsFailed(): Promise<number> {
  const rows = await sql`
    UPDATE executions
    SET status = 'failed', error = 'Server restarted', completed_at = NOW()
    WHERE status IN ('running', 'pending')
    RETURNING id
  `;
  return rows.length;
}
