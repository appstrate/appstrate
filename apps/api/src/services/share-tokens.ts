import crypto from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { shareTokens } from "@appstrate/db/schema";

const DEFAULT_EXPIRES_DAYS = 7;

export async function createShareToken(
  flowId: string,
  createdBy: string,
  orgId: string,
  expiresInDays = DEFAULT_EXPIRES_DAYS,
) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(shareTokens)
    .values({ token, flowId, createdBy, orgId, expiresAt })
    .returning();

  return row;
}

export async function getShareToken(token: string) {
  const rows = await db.select().from(shareTokens).where(eq(shareTokens.token, token)).limit(1);
  return rows[0] ?? null;
}

export async function consumeShareToken(token: string) {
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(shareTokens)
      .where(
        and(
          eq(shareTokens.token, token),
          isNull(shareTokens.consumedAt),
          gt(shareTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0]!;
    await tx.update(shareTokens).set({ consumedAt: new Date() }).where(eq(shareTokens.id, row.id));

    return {
      id: row.id,
      flowId: row.flowId,
      createdBy: row.createdBy,
      orgId: row.orgId,
    };
  });

  return result;
}

export async function linkExecutionToToken(tokenId: string, executionId: string) {
  await db.update(shareTokens).set({ executionId }).where(eq(shareTokens.id, tokenId));
}
