import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  flows,
  executions,
  flowSchedules,
  flowConfigs,
  flowVersions,
  flowAdminConnections,
} from "@appstrate/db/schema";
import type { Flow } from "@appstrate/db/schema";

export type FlowRow = Flow;

export async function getFlowById(id: string): Promise<FlowRow | null> {
  const rows = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertUserFlow(
  id: string,
  orgId: string,
  manifest: Record<string, unknown>,
  prompt: string,
): Promise<FlowRow> {
  const now = new Date();
  const [row] = await db
    .insert(flows)
    .values({ id, orgId, manifest, prompt, createdAt: now, updatedAt: now })
    .returning();
  if (!row) throw new Error("Failed to insert flow: no row returned");
  return row;
}

export async function updateUserFlow(
  id: string,
  payload: {
    manifest: Record<string, unknown>;
    prompt: string;
  },
  expectedUpdatedAt: string,
): Promise<FlowRow | null> {
  const rows = await db
    .update(flows)
    .set({
      manifest: payload.manifest,
      prompt: payload.prompt,
      updatedAt: new Date(),
    })
    .where(and(eq(flows.id, id), eq(flows.updatedAt, new Date(expectedUpdatedAt))))
    .returning();

  return rows[0] ?? null;
}

export async function deleteUserFlow(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    // flow_skills and flow_extensions cascade-deleted via flows FK
    // execution_logs cascade-deleted via executions FK
    await tx.delete(executions).where(eq(executions.flowId, id));
    await tx.delete(flowSchedules).where(eq(flowSchedules.flowId, id));
    await tx.delete(flowConfigs).where(eq(flowConfigs.flowId, id));
    await tx.delete(flowVersions).where(eq(flowVersions.flowId, id));
    await tx.delete(flowAdminConnections).where(eq(flowAdminConnections.flowId, id));
    await tx.delete(flows).where(eq(flows.id, id));
  });
}
