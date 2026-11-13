// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The Better Auth side of enterprise sign-in: who may open a session for an
 * address of a domain an organization proved, and for how long.
 *
 * The choke point is SESSION CREATION (`databaseHooks.session.create.before`):
 * every way Better Auth signs a person in ends there, so for an address of an
 * enforced domain a fail-closed allowlist (`decideSession`) admits the
 * Microsoft callback of the bound tenant and an owner's emergency password
 * sign-in, and refuses every other path, a method added later included.
 *
 * Around it:
 *  - `account.create/update.before` read the tenant (`tid`) of the Microsoft
 *    identity being signed in or linked, off the ID token Better Auth just
 *    received, and refuse a foreign tenant before anything is linked;
 *  - a `before` hook on `/sign-in/email` refuses BEFORE the password is
 *    checked, so the answer never says whether it was right; its emergency
 *    variant (`?emergency=1`) lets owners of the enforcing organization through
 *    and answers everyone else exactly like a wrong password;
 *  - `session.update.before` keeps a refresh from sliding an enforced
 *    session past its 24 h cap;
 *  - `session.create.after` records the Microsoft origin of a session and
 *    admits a newcomer of the domain into the organization (auto-join).
 *
 * Applies to accounts of the `platform` realm only.
 */

import { BASE_ERROR_CODES, getCurrentAdapter } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { defineRequestState } from "@better-auth/core/context";
import { emailDomainOf } from "./domain.ts";
import { cappedRefresh, decideSession, type SessionOrigin, type SsoRefusal } from "./policy.ts";
import {
  findDomainPolicy,
  microsoftSessionOf,
  recordMicrosoftSession,
  type DomainPolicy,
} from "./store.ts";
import { getPlatform, orgRoleOf } from "../platform.ts";

const MICROSOFT = "microsoft";
const CALLBACK_PATH = "/callback/:id";

/** The adapter surface these hooks read through (Better Auth's, typed loosely on purpose). */
interface UserReader {
  findOne<T>(args: {
    model: string;
    where: { field: string; value: unknown }[];
    select?: string[];
  }): Promise<T | null>;
}

/** The slice of Better Auth's endpoint context these hooks read. */
interface HookContext {
  path?: string;
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  context: {
    adapter: unknown;
    baseURL: string;
    session?: { session: { userId: string; createdAt: Date | string } } | null;
  };
  redirect(url: string): unknown;
}

/** What one sign-in request learned on its way to the session it may open. */
interface SignInState {
  /** The tenant of the Microsoft identity this callback signed in. */
  microsoftTenant: string | null;
  /** The account an owner's emergency sign-in was cleared for. */
  breakGlassUserId: string | null;
}

const signInState = defineRequestState<SignInState>(() => ({
  microsoftTenant: null,
  breakGlassUserId: null,
}));

/** The request state, or `null` outside a Better Auth request (scripts, seeds). */
async function currentState(): Promise<SignInState | null> {
  try {
    return await signInState.get();
  } catch {
    return null;
  }
}

let authAdapter: UserReader | null = null;

async function readUser(
  userId: string,
  context: HookContext | null,
): Promise<{ email: string; realm: string } | null> {
  const adapter: UserReader | null = context
    ? ((await getCurrentAdapter(context.context.adapter as never)) as unknown as UserReader)
    : authAdapter;
  if (!adapter) return null;
  const row = await adapter.findOne<{ email: string; realm?: string }>({
    model: "user",
    where: [{ field: "id", value: userId }],
    select: ["email", "realm"],
  });
  return row ? { email: row.email, realm: row.realm ?? "platform" } : null;
}

async function policyForEmail(email: string | null | undefined): Promise<DomainPolicy | null> {
  const domain = typeof email === "string" ? emailDomainOf(email) : null;
  return domain ? findDomainPolicy(domain) : null;
}

const REFUSAL_MESSAGES: Record<SsoRefusal, string> = {
  sso_required: "This address belongs to an organization that requires signing in with Microsoft.",
  sso_tenant_mismatch:
    "This Microsoft account does not belong to the tenant of the organization that owns this address.",
};

/** Browser GETs answered with a redirect carrying the code, like Better Auth's own refusals. */
const REDIRECTED_PATHS: ReadonlySet<string> = new Set(["/magic-link/verify", "/verify-email"]);

function refusal(context: HookContext | null, code: SsoRefusal): unknown {
  if (context?.path && REDIRECTED_PATHS.has(context.path)) {
    const raw = context.query?.errorCallbackURL ?? context.query?.callbackURL;
    const target = new URL(
      typeof raw === "string" ? decodeURIComponent(raw) : "/",
      context.context.baseURL,
    );
    target.searchParams.set("error", code);
    return context.redirect(target.toString());
  }
  return new APIError("FORBIDDEN", { code, message: REFUSAL_MESSAGES[code] });
}

/**
 * The `tid` and `email` claims of an ID token Better Auth just received from
 * Microsoft's token endpoint over TLS (the same token its provider decodes for
 * the profile), so the signature is not re-checked here.
 */
export function idTokenClaims(idToken: unknown): { tenantId: string | null; email: string | null } {
  const none = { tenantId: null, email: null };
  if (typeof idToken !== "string") return none;
  try {
    const claims = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { tid?: unknown; email?: unknown };
    return {
      tenantId: typeof claims.tid === "string" ? claims.tid : null,
      email: typeof claims.email === "string" ? claims.email : null,
    };
  } catch {
    return none;
  }
}

/**
 * A Microsoft identity is being signed in or linked by the OAuth callback:
 * remember its tenant for the session hook, and refuse it outright when the
 * address it carries, or the account it lands on, belongs to a domain bound to
 * another tenant.
 */
async function onMicrosoftAccount(
  account: { providerId?: unknown; idToken?: unknown; userId?: unknown },
  context: HookContext | null,
): Promise<void> {
  if (account.providerId !== MICROSOFT || context?.path !== CALLBACK_PATH) return;
  const { tenantId, email } = idTokenClaims(account.idToken);
  const state = await currentState();
  if (state) state.microsoftTenant = tenantId;
  const owner = typeof account.userId === "string" ? await readUser(account.userId, context) : null;
  if (owner && owner.realm !== "platform") return;
  for (const address of [email, owner?.email]) {
    const policy = await policyForEmail(address);
    if (policy && policy.tenantId !== tenantId) throw refusal(context, "sso_tenant_mismatch");
  }
}

/** Classify how this session is being opened (see `SessionOrigin`). */
function originOf(
  userId: string,
  context: HookContext | null,
  state: SignInState | null,
): SessionOrigin {
  const path = context?.path;
  if (path === CALLBACK_PATH && context?.params?.id === MICROSOFT) {
    return { kind: "microsoft", tenantId: state?.microsoftTenant ?? null };
  }
  if (path === "/sign-in/email" && state?.breakGlassUserId === userId)
    return { kind: "break_glass" };
  const replaced = context?.context.session?.session;
  if (path === "/change-password" && replaced?.userId === userId) {
    return { kind: "rotation", replacedCreatedAt: new Date(replaced.createdAt) };
  }
  return { kind: "other" };
}

async function beforeSessionCreate(
  session: { userId: string; expiresAt: Date },
  context: HookContext | null,
): Promise<{ data: { expiresAt: Date; createdAt?: Date } } | void> {
  const user = await readUser(session.userId, context);
  if (!user || user.realm !== "platform") return;
  const policy = await policyForEmail(user.email);
  if (!policy) return;
  const decision = decideSession(
    policy,
    originOf(session.userId, context, await currentState()),
    new Date(session.expiresAt),
    new Date(),
  );
  if (!decision.allow) {
    getPlatform().services.logger.warn("ee: sign-in refused by the organization's policy", {
      module: "ee",
      orgId: policy.orgId,
      code: decision.code,
      path: context?.path ?? null,
    });
    throw refusal(context, decision.code);
  }
  return {
    data: {
      expiresAt: decision.expiresAt,
      ...(decision.createdAt ? { createdAt: decision.createdAt } : {}),
    },
  };
}

/**
 * After a Microsoft session: record its tenant, then let a newcomer of a
 * domain the same tenant is bound to join the organization. Never fails the
 * sign-in: an auto-join that did not happen is retried at the next one.
 */
async function afterSessionCreate(
  session: { id: string; userId: string } | null,
  context: HookContext | null,
): Promise<void> {
  if (!session || context?.path !== CALLBACK_PATH || context.params?.id !== MICROSOFT) return;
  const { logger, members } = getPlatform().services;
  try {
    const tenantId = (await currentState())?.microsoftTenant;
    if (!tenantId) return;
    await recordMicrosoftSession(session.id, session.userId, tenantId);
    const user = await readUser(session.userId, context);
    if (!user || user.realm !== "platform") return;
    const policy = await policyForEmail(user.email);
    if (!policy || policy.tenantId !== tenantId) return;
    if (await orgRoleOf(policy.orgId, session.userId)) return;
    const { created } = await members.provision(policy.orgId, session.userId, policy.joinRole);
    if (created) {
      logger.info("ee: joined the organization of the address's domain", {
        module: "ee",
        orgId: policy.orgId,
        userId: session.userId,
        role: policy.joinRole,
      });
    }
  } catch (err) {
    logger.error("ee: after Microsoft sign-in", {
      module: "ee",
      userId: session.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function beforeSessionUpdate(
  data: { expiresAt?: unknown },
  context: HookContext | null,
): Promise<{ data: { expiresAt: Date } } | void> {
  if (!(data.expiresAt instanceof Date)) return;
  const current = (context?.context as { session?: unknown } | undefined)?.session as
    | { session: { createdAt: Date | string }; user: { email: string; realm?: string } }
    | null
    | undefined;
  if (!current?.session || !current.user) return;
  if ((current.user.realm ?? "platform") !== "platform") return;
  const policy = await policyForEmail(current.user.email);
  if (!policy?.enforced) return;
  return {
    data: { expiresAt: cappedRefresh(new Date(current.session.createdAt), data.expiresAt) },
  };
}

function readBodyEmail(body: unknown, field = "email"): string | null {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

/**
 * The email-change link (`/verify-email` carrying `updateTo`): neither the
 * address it leaves nor the one it moves to may be enforced. Better Auth has
 * verified the token's signature before it writes, so its payload is read as is.
 */
async function beforeUserUpdate(
  data: { email?: unknown },
  context: HookContext | null,
): Promise<void> {
  if (typeof data.email !== "string") return;
  const addresses: unknown[] = [data.email];
  const token = context?.query?.token;
  if (context?.path === "/verify-email" && typeof token === "string") {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as { email?: unknown };
      addresses.push(payload.email);
    } catch {
      // Not a JWT: Better Auth refused it before any write.
    }
  }
  for (const address of addresses) {
    if (typeof address === "string" && (await policyForEmail(address))?.enforced) {
      throw refusal(context, "sso_required");
    }
  }
}

/**
 * `/sign-in/email`: for an address of an enforced domain, decided before
 * Better Auth looks at the password. An existing account of another realm is
 * left alone; an absent account is refused like a present one, so the answer
 * says nothing about which addresses have an account.
 */
const passwordSignInGate = createAuthMiddleware(async (ctx) => {
  const email = readBodyEmail(ctx.body);
  if (!email) return;
  const policy = await policyForEmail(email);
  if (!policy?.enforced) return;
  const found = (await ctx.context.internalAdapter.findUserByEmail(email)) as {
    user: { id: string; realm?: string };
  } | null;
  if (found && (found.user.realm ?? "platform") !== "platform") return;
  if (ctx.query?.emergency !== "1") throw refusal(null, "sso_required");
  // Emergency path: owners of the enforcing organization only. Anyone else
  // gets what a wrong password gets, after the same hashing work, and their
  // password is never checked.
  const isOwner = found ? (await orgRoleOf(policy.orgId, found.user.id)) === "owner" : false;
  if (!isOwner) {
    const password = (ctx.body as { password?: unknown } | undefined)?.password;
    await ctx.context.password.hash(typeof password === "string" ? password : "");
    throw APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
  }
  const state = await currentState();
  if (state) state.breakGlassUserId = found!.user.id;
  getPlatform().services.logger.warn(
    "ee: emergency sign-in by an owner of an enforcing organization",
    {
      module: "ee",
      orgId: policy.orgId,
      userId: found!.user.id,
    },
  );
});

/**
 * `/change-email`: the obligation follows the address. While a domain is
 * enforced, an account may neither leave it (escaping the tenant's control)
 * nor move into it (holding a session no Microsoft sign-in opened).
 */
const changeEmailGate = createAuthMiddleware(async (ctx) => {
  const session = await getSessionFromCtx(ctx);
  const realm = (session?.user as { realm?: string } | undefined)?.realm ?? "platform";
  if (!session || realm !== "platform") return;
  for (const email of [session.user.email, readBodyEmail(ctx.body, "newEmail")]) {
    if ((await policyForEmail(email))?.enforced) throw refusal(null, "sso_required");
  }
});

/**
 * The `beforeSignup` broadcast hook: no new platform account at an enforced
 * address unless the OAuth callback creates it — there the session decision
 * (Microsoft of the bound tenant, or nothing) still applies.
 */
export async function refuseEnforcedSignup(
  email: string,
  ctx: { path?: string | null; realm?: () => Promise<string> },
): Promise<void> {
  if (ctx.path === CALLBACK_PATH) return;
  const policy = await policyForEmail(email);
  if (!policy?.enforced) return;
  const realm = ctx.realm ? await ctx.realm() : "platform";
  if (realm !== "platform") return;
  throw refusal(null, "sso_required");
}

/** Whether `sessionId` was opened by a Microsoft sign-in of `userId`, and from which tenant. */
export async function microsoftTenantOfSession(
  sessionId: string | undefined,
  userId: string,
): Promise<{ tenantId: string; createdAt: Date } | null> {
  if (!sessionId) return null;
  const origin = await microsoftSessionOf(sessionId);
  return origin && origin.userId === userId ? origin : null;
}

export function enterpriseSignInPlugin() {
  return {
    id: "appstrate-ee-enterprise-sign-in",
    init(ctx: { adapter: unknown }) {
      authAdapter = ctx.adapter as UserReader;
      return {
        options: {
          databaseHooks: {
            user: { update: { before: beforeUserUpdate } },
            account: {
              create: { before: onMicrosoftAccount },
              update: { before: onMicrosoftAccount },
            },
            session: {
              create: { before: beforeSessionCreate, after: afterSessionCreate },
              update: { before: beforeSessionUpdate },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/sign-in/email",
          handler: passwordSignInGate,
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/change-email",
          handler: changeEmailGate,
        },
      ],
    },
  };
}
