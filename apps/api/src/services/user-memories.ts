// SPDX-License-Identifier: Apache-2.0

/**
 * The assistant's memory of a person (`user_memories`, `@appstrate/core/user-memory`).
 *
 * Every function takes the person's `userId` first and narrows on it: the
 * memory is reachable by its owner alone, so there is no org or space scope to
 * check: the routes and the MCP tool admit only the person's own credential
 * (`isUserPrincipal`) before calling in here.
 *
 * Two halves make the CORE the chat loads: the memories with no origin (about
 * the person) and the current organization's. Each half has a character budget;
 * a write that would overflow it is refused with `memory_full`, so the writer
 * condenses instead of the memory growing without bound.
 */

import { and, asc, eq, gte, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { prefixedId } from "@appstrate/db/ids";
import {
  organizationMembers,
  organizations,
  profiles,
  spaces,
  userMemories,
} from "@appstrate/db/schema";
import {
  USER_MEMORY_ORG_BUDGET_CHARS,
  USER_MEMORY_PERSONAL_BUDGET_CHARS,
  USER_MEMORY_TYPES,
  type UserMemoryType,
} from "@appstrate/core/user-memory";
import { ApiError, conflict, invalidRequest, notFound } from "../lib/errors.ts";
import type { DbOrTx } from "../lib/db-helpers.ts";
import { getOrgMember, getOrgSettings } from "./organizations.ts";

export interface UserMemory {
  id: string;
  type: UserMemoryType;
  subject: string | null;
  content: string;
  /** Origin: null = about the person. */
  orgId: string | null;
  createdBy: "user" | "assistant";
  createdAt: Date;
  updatedAt: Date;
}

/** A memory with its origin's name, for a reader that renders it. */
export interface NamedUserMemory extends UserMemory {
  orgName: string | null;
}

/** A memory as the settings page lists it: named, and whether the person still belongs to its origin. */
export interface UserMemoryListItem extends NamedUserMemory {
  orgMember: boolean;
}

const columns = {
  id: userMemories.id,
  type: userMemories.type,
  subject: userMemories.subject,
  content: userMemories.content,
  orgId: userMemories.orgId,
  createdBy: userMemories.createdBy,
  createdAt: userMemories.createdAt,
  updatedAt: userMemories.updatedAt,
};

const namedColumns = { ...columns, orgName: organizations.name };

/** Rendering order: by type as `USER_MEMORY_TYPES` lists them, then oldest first. */
const typeOrder = sql`array_position(ARRAY[${sql.join(
  USER_MEMORY_TYPES.map((t) => sql`${t}`),
  sql`, `,
)}]::text[], ${userMemories.type})`;

/**
 * Is the memory on for this person here? Their own switch, then the org's.
 * `orgId` null = outside any organization (only the person's switch applies).
 */
export async function isUserMemoryEnabled(userId: string, orgId: string | null): Promise<boolean> {
  const [row] = await db
    .select({ on: profiles.assistantMemory })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (row && !row.on) return false;
  if (!orgId) return true;
  const settings = await getOrgSettings(orgId);
  return settings.assistant_memory !== false;
}

/** The core: about the person + learned in `orgId`, in rendering order. */
export async function getUserMemoryCore(
  userId: string,
  orgId: string | null,
): Promise<NamedUserMemory[]> {
  const origin = orgId
    ? or(isNull(userMemories.orgId), eq(userMemories.orgId, orgId))
    : isNull(userMemories.orgId);
  return db
    .select(namedColumns)
    .from(userMemories)
    .leftJoin(organizations, eq(organizations.id, userMemories.orgId))
    .where(and(eq(userMemories.userId, userId), origin))
    .orderBy(typeOrder, asc(userMemories.createdAt));
}

/**
 * Everything the person owns, for the settings page, including memories from
 * orgs they left. `id` narrows to one (the read-back after a write).
 */
export async function listUserMemories(
  caller: MemoryCaller,
  id?: string,
): Promise<UserMemoryListItem[]> {
  const rows = await db
    .select({
      ...namedColumns,
      orgMember: sql<boolean>`${organizationMembers.userId} IS NOT NULL`,
    })
    .from(userMemories)
    .leftJoin(organizations, eq(organizations.id, userMemories.orgId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, userMemories.orgId),
        eq(organizationMembers.userId, userMemories.userId),
      ),
    )
    .where(and(visibleTo(caller), id ? eq(userMemories.id, id) : undefined))
    .orderBy(typeOrder, asc(userMemories.createdAt));
  return rows.map((row) => ({ ...row, orgMember: row.orgId === null || row.orgMember }));
}

/** Content characters already used by one half of the core, `excludeId` left out. */
async function usedChars(
  tx: DbOrTx,
  userId: string,
  orgId: string | null,
  excludeId?: string,
): Promise<number> {
  const filters: SQL[] = [
    eq(userMemories.userId, userId),
    orgId ? eq(userMemories.orgId, orgId) : isNull(userMemories.orgId),
  ];
  if (excludeId) filters.push(sql`${userMemories.id} <> ${excludeId}`);
  const [row] = await tx
    .select({ used: sql<number>`COALESCE(SUM(char_length(${userMemories.content})), 0)::int` })
    .from(userMemories)
    .where(and(...filters));
  return row?.used ?? 0;
}

/**
 * Refuse a write that would overflow its half. The refusal names the budget and
 * the usage, and tells the writer to condense: merge memories, drop what is stale.
 */
async function assertFits(
  tx: DbOrTx,
  userId: string,
  orgId: string | null,
  addChars: number,
  excludeId?: string,
): Promise<void> {
  const budget = orgId ? USER_MEMORY_ORG_BUDGET_CHARS : USER_MEMORY_PERSONAL_BUDGET_CHARS;
  const used = await usedChars(tx, userId, orgId, excludeId);
  if (used + addChars > budget) {
    throw conflict(
      "memory_full",
      `This part of the memory is full (${used} of ${budget} characters used). Condense it first: merge related memories or remove stale ones, then retry.`,
      { budget, used, scope: orgId ? "org" : "me" },
    );
  }
}

// Shapes that are credentials whatever their context. Not an exhaustive secret
// scanner: the obvious cases the prompt already forbids, refused at the write.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bapst_[A-Za-z0-9_-]{8,}/, // Appstrate API key
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // Anthropic / OpenAI keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function assertNoSecret(text: string): void {
  const cardLike = text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  const card = cardLike.some((m) => luhnValid(m.replace(/[ -]/g, "")));
  if (card || SECRET_PATTERNS.some((re) => re.test(text))) {
    throw invalidRequest("A memory cannot hold a password, key, token or card number.", "content");
  }
}

/**
 * Serialize the writes to one half of one person's memory, so two concurrent
 * writes (a model calls tools in parallel) cannot both pass the budget check.
 */
async function lockHalf(tx: DbOrTx, userId: string, orgId: string | null): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`user-memory:${userId}:${orgId ?? "me"}`})::bigint)`,
  );
}

/**
 * Who reaches the memory. The person themselves (their session, their CLI) is
 * bound to no organization (`boundOrgId: null`) and reaches every memory: it is
 * their data. A credential bound to ONE organization (the chat's token, an MCP
 * client's token audience-bound to that organization's endpoint) is an
 * assistant acting there: it reaches what is about the person and what belongs
 * to that organization, nothing learned elsewhere, and writes as `assistant`.
 * One rule for the REST routes and the `memory` MCP tool alike.
 */
export interface MemoryCaller {
  userId: string;
  boundOrgId: string | null;
}

/** The rows a caller reaches. */
function visibleTo(caller: MemoryCaller): SQL {
  return and(
    eq(userMemories.userId, caller.userId),
    caller.boundOrgId
      ? or(isNull(userMemories.orgId), eq(userMemories.orgId, caller.boundOrgId))
      : undefined,
  )!;
}

function outsideOrganization(): ApiError {
  return new ApiError({
    status: 403,
    code: "memory_outside_organization",
    title: "Forbidden",
    detail:
      "This credential acts in one organization: it reaches what is about the person and what belongs to that organization, nothing learned in another.",
  });
}

/**
 * A bound caller (an assistant) is refused while the person's switch or its
 * organization's is off. The person themselves always reaches their memory,
 * to read or erase it, switch on or off.
 */
export async function assertMemoryOpen(caller: MemoryCaller): Promise<void> {
  if (!caller.boundOrgId) return;
  if (await isUserMemoryEnabled(caller.userId, caller.boundOrgId)) return;
  throw new ApiError({
    status: 403,
    code: "memory_off",
    title: "Forbidden",
    detail:
      "The assistant's memory is turned off for this person in this organization. Do not read or write it, and do not tell the user you remembered anything.",
  });
}

export interface UserMemoryInput {
  type: UserMemoryType;
  content: string;
  subject?: string | null;
  /** Origin: null = about the person. */
  orgId: string | null;
  sourceSessionId?: string | null;
}

export async function addUserMemory(
  caller: MemoryCaller,
  input: UserMemoryInput,
): Promise<UserMemory> {
  const { userId, boundOrgId } = caller;
  const content = input.content.trim();
  assertNoSecret(content);
  // An assistant files a preference as about the person: asked for its org
  // instead, a model would hide it from every other organization (seen live).
  const orgId = boundOrgId && input.type === "preference" ? null : input.orgId;
  if (boundOrgId && orgId !== null && orgId !== boundOrgId) throw outsideOrganization();
  if (orgId && !(await getOrgMember(orgId, userId))) {
    throw invalidRequest("orgId must be an organization you belong to", "orgId");
  }
  return db.transaction(async (tx) => {
    await lockHalf(tx, userId, orgId);
    await assertFits(tx, userId, orgId, content.length);
    const [row] = await tx
      .insert(userMemories)
      .values({
        id: prefixedId("mem"),
        userId,
        orgId,
        type: input.type,
        subject: input.subject?.trim() || null,
        content,
        createdBy: boundOrgId ? "assistant" : "user",
        sourceSessionId: input.sourceSessionId ?? null,
      })
      .returning(columns);
    return row!;
  });
}

export interface UserMemoryPatch {
  type?: UserMemoryType;
  content?: string;
  subject?: string | null;
}

export async function updateUserMemory(
  caller: MemoryCaller,
  id: string,
  patch: UserMemoryPatch,
): Promise<UserMemory> {
  const owned = and(eq(userMemories.id, id), visibleTo(caller));
  const [current] = await db.select(columns).from(userMemories).where(owned).limit(1);
  if (!current) throw notFound(`Memory '${id}' not found`);
  const content = patch.content?.trim();
  if (content !== undefined) assertNoSecret(content);
  return db.transaction(async (tx) => {
    if (content !== undefined) {
      await lockHalf(tx, caller.userId, current.orgId);
      await assertFits(tx, caller.userId, current.orgId, content.length, id);
    }
    const [row] = await tx
      .update(userMemories)
      .set({
        ...(patch.type ? { type: patch.type } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject?.trim() || null } : {}),
        updatedAt: new Date(),
      })
      .where(owned)
      .returning(columns);
    if (!row) throw notFound(`Memory '${id}' not found`);
    return row;
  });
}

export async function deleteUserMemory(caller: MemoryCaller, id: string): Promise<void> {
  const deleted = await db
    .delete(userMemories)
    .where(and(eq(userMemories.id, id), visibleTo(caller)))
    .returning({ id: userMemories.id });
  if (deleted.length === 0) throw notFound(`Memory '${id}' not found`);
}

/**
 * Forget in bulk. `orgId` given: what the person learned in that org
 * (`null` = what is about them). Omitted: everything the caller reaches.
 * Returns the count.
 */
export async function deleteUserMemories(
  caller: MemoryCaller,
  opts: { orgId?: string | null } = {},
): Promise<number> {
  if (caller.boundOrgId && opts.orgId && opts.orgId !== caller.boundOrgId) {
    throw outsideOrganization();
  }
  const filters: SQL[] = [visibleTo(caller)];
  if (opts.orgId !== undefined) {
    filters.push(
      opts.orgId === null ? isNull(userMemories.orgId) : eq(userMemories.orgId, opts.orgId),
    );
  }
  const deleted = await db
    .delete(userMemories)
    .where(and(...filters))
    .returning({ id: userMemories.id });
  return deleted.length;
}

/** An admin's purge: every member's memories learned in `orgId`. Returns the count. */
export async function deleteOrgUserMemories(orgId: string): Promise<number> {
  const deleted = await db
    .delete(userMemories)
    .where(eq(userMemories.orgId, orgId))
    .returning({ id: userMemories.id });
  return deleted.length;
}

/**
 * Erase what members learned in an organization they left, once the
 * offboarding window has closed. The window is the one of their personal space
 * (`spaces.orphaned_at`, `PERSONAL_SPACE_GRACE_DAYS`): while that space is
 * still waiting out its grace period the memories wait with it, and a member
 * who comes back finds both. With no such space left (swept, or converted to a
 * team space by an admin) nothing holds them. Run by the personal-space
 * sweeper after its own pass. Returns the count.
 */
export async function sweepDepartedMemberMemories(graceCutoff: Date): Promise<number> {
  const stillMember = db
    .select({ one: sql`1` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, userMemories.orgId),
        eq(organizationMembers.userId, userMemories.userId),
      ),
    );
  const inGrace = db
    .select({ one: sql`1` })
    .from(spaces)
    .where(
      and(
        eq(spaces.orgId, userMemories.orgId),
        eq(spaces.ownerUserId, userMemories.userId),
        gte(spaces.orphanedAt, graceCutoff),
      ),
    );
  const deleted = await db
    .delete(userMemories)
    .where(
      and(
        sql`${userMemories.orgId} IS NOT NULL`,
        sql`NOT EXISTS (${stillMember})`,
        sql`NOT EXISTS (${inGrace})`,
      ),
    )
    .returning({ id: userMemories.id });
  return deleted.length;
}
