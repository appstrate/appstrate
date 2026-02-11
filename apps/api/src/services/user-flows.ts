import sql from "../db/client.ts";

export interface UserFlowRow {
  id: string;
  manifest: Record<string, unknown>;
  prompt: string;
  skills: { id: string; description: string; content: string }[];
  created_at: string;
  updated_at: string;
}

export async function listUserFlows(): Promise<UserFlowRow[]> {
  const rows = await sql`SELECT * FROM user_flows ORDER BY created_at DESC`;
  return rows as unknown as UserFlowRow[];
}

export async function getUserFlow(id: string): Promise<UserFlowRow | null> {
  const rows = await sql`SELECT * FROM user_flows WHERE id = ${id}`;
  return (rows[0] as unknown as UserFlowRow) ?? null;
}

export async function userFlowExists(id: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM user_flows WHERE id = ${id} LIMIT 1`;
  return rows.length > 0;
}

export async function insertUserFlow(
  id: string,
  manifest: Record<string, unknown>,
  prompt: string,
  skills: { id: string; description: string; content: string }[],
): Promise<void> {
  await sql`
    INSERT INTO user_flows (id, manifest, prompt, skills)
    VALUES (${id}, ${sql.json(manifest)}, ${prompt}, ${sql.json(skills)})
  `;
}

export async function deleteUserFlow(id: string): Promise<void> {
  // Clean up related tables first
  await sql`DELETE FROM execution_logs WHERE execution_id IN (SELECT id FROM executions WHERE flow_id = ${id})`;
  await sql`DELETE FROM executions WHERE flow_id = ${id}`;
  await sql`DELETE FROM flow_schedules WHERE flow_id = ${id}`;
  await sql`DELETE FROM flow_configs WHERE flow_id = ${id}`;
  await sql`DELETE FROM flow_state WHERE flow_id = ${id}`;
  await sql`DELETE FROM user_flows WHERE id = ${id}`;
}
