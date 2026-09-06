// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" — an owner or admin previews the product as a lesser persona.
 *
 * A pure RESTRICTION from the caller's own session: nothing is minted,
 * `c.get("user")` and `c.get("orgRole")` stay real, and only "what does this
 * caller reach" changes — hence its application at the sites that already write
 * `permissions`. Every step is a REFUSAL. Three carriers, one validation
 * ({@link validateViewAs}): the `X-View-As` header, `?view_as=` on the SSE
 * routes (no pipeline, and `EventSource` sends no headers), and the chat
 * module's signed loopback claims. Validated in ONE org, applies only there
 * ({@link personaFor}).
 *
 * Only the ORG set is intersected with the caller's own ({@link orgHalfFor}),
 * because `grantTo` has no nesting rule: a
 * module may grant an org-level permission to `member` and not to `owner`. The
 * SPACE slice is a subset of the previewer's by construction — presets are
 * upward-closed (`assertPresetsUpwardClosed`), eligibility is owner/admin whose
 * real standing in every space is preset `admin`, and a custom bundle is checked
 * grantable at validation. **Widening eligibility below org admin breaks all
 * three**: it must reintroduce a space-half intersection AND read the
 * previewer's real `space_members` row.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7
 */

import type { Context, Next } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaceRoles } from "@appstrate/db/schema";
import {
  reportPermissionDenial,
  SPACE_ROLE_PRESETS,
  VIEW_AS_ACTIVE_HEADER,
  VIEW_AS_HEADER,
  VIEW_AS_ORG_ROLES,
} from "@appstrate/core/permissions";
import type { OrgRole, SpaceRolePreset, ViewAsOrgRole } from "@appstrate/core/permissions";
import { ApiError } from "./errors.ts";
import { isSpaceRoleId, SPACE_ID_RE } from "./ids.ts";
import { effectivePermissions, orgPermissions } from "./permissions.ts";
import {
  loadSpaceMember,
  loadSpaceMemberships,
  resolveSpaceRole,
  spacePermissions,
  toSpaceRoleWire,
  type SpaceMemberRow,
  type SpaceRoleRef,
} from "./space-role.ts";
import { canGrantSpaceRole } from "./space-role-policy.ts";
import { hasCustomRoles } from "../services/space-roles.ts";
import { validateSpaceInOrg } from "./space-lookup.ts";
import type { AppEnv } from "../types/index.ts";

export interface ViewAsPersona {
  /** Org it was validated in; outside it the caller is themselves. */
  orgId: string;
  orgRole: ViewAsOrgRole;
  space: { spaceId: string; role: SpaceRoleRef } | null;
}

/** The role half of a request; a custom bundle is still just an id here. */
type PersonaRoleRequest =
  { kind: "preset"; preset: SpaceRolePreset } | { kind: "custom"; roleId: string };

interface ViewAsRequest {
  orgRole: ViewAsOrgRole;
  space: { spaceId: string; role: PersonaRoleRequest } | null;
}

/** `.strict()` so a misspelled `space` is a refusal, not a whole-org preview; ids shape-checked here. */
const viewAsSchema = z
  .object({
    org_role: z.enum(VIEW_AS_ORG_ROLES),
    space: z.string().refine((v) => SPACE_ID_RE.test(v), {
      message: "space must be a `spc_` id followed by a canonical UUID",
    }),
    role: z
      .string()
      .refine(
        (v) =>
          new RegExp(`^preset:(?:${SPACE_ROLE_PRESETS.join("|")})$`).test(v) ||
          (v.startsWith("custom:") && isSpaceRoleId(v.slice("custom:".length))),
        { message: `role must be preset:<${SPACE_ROLE_PRESETS.join("|")}> or custom:<srl_ id>` },
      ),
  })
  .partial({ space: true, role: true })
  .strict()
  .refine((v) => (v.space === undefined) === (v.role === undefined), {
    message: "space and role must be provided together",
  });

/** Shape {@link adoptViewAs} accepts off the loopback bearer. */
const personaSchema: z.ZodType<ViewAsPersona> = z.object({
  orgId: z.string(),
  orgRole: z.enum(VIEW_AS_ORG_ROLES),
  space: z
    .object({
      spaceId: z.string(),
      role: z.union([
        z.object({ kind: z.literal("preset"), preset: z.enum(SPACE_ROLE_PRESETS) }),
        z.object({
          kind: z.literal("custom"),
          role: z.object({
            id: z.string(),
            key: z.string(),
            name: z.string(),
            permissions: z.array(z.string()),
          }),
        }),
      ]),
    })
    .nullable(),
});

function invalidViewAs(detail: string): ApiError {
  return new ApiError({
    status: 400,
    code: "invalid_view_as",
    title: "Invalid View-As Header",
    detail,
    param: VIEW_AS_HEADER,
  });
}

function viewAsForbidden(detail: string): ApiError {
  return new ApiError({
    status: 403,
    code: "view_as_forbidden",
    title: "View-As Forbidden",
    detail,
    param: VIEW_AS_HEADER,
  });
}

/**
 * A 404 the PERSONA caused — its space, its custom role or its organization is
 * gone. Its own code rather than the generic `not_found` because that is the
 * only thing that tells a client "your preview died, drop it" apart from "the
 * thing you asked for does not exist, which is what the previewed role sees".
 * Both are 404s on the same routes; the code is the discriminator.
 */
function viewAsNotFound(detail: string): ApiError {
  return new ApiError({
    status: 404,
    code: "view_as_not_found",
    title: "View-As Target Not Found",
    detail,
    param: VIEW_AS_HEADER,
  });
}

/**
 * Whitespace tolerated (headers get reformatted in transit); an empty segment,
 * a missing `=` or a repeated key is `null` — "last one wins" on a security
 * header is how two readers disagree. Prototype-less, so `toString=x` is not a repeat.
 */
function splitFields(header: string): Record<string, string> | null {
  const fields = Object.create(null) as Record<string, string>;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) return null;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key === "" || value === "" || key in fields) return null;
    fields[key] = value;
  }
  return fields;
}

/** `null` when absent, a throw when present and unreadable — never the same thing. */
function parseViewAs(raw: string | undefined): ViewAsRequest | null {
  if (raw === undefined) return null;
  const fields = splitFields(raw);
  const parsed = fields === null ? null : viewAsSchema.safeParse({ ...fields });
  if (!parsed?.success) {
    const reason = parsed
      ? parsed.error.issues.map((issue) => issue.message).join("; ")
      : "expected `key=value` pairs separated by `;`, each key at most once";
    throw invalidViewAs(`${VIEW_AS_HEADER} could not be parsed: ${reason}`);
  }
  const { org_role, space, role } = parsed.data;
  return {
    orgRole: org_role,
    space:
      space === undefined || role === undefined
        ? null
        : {
            spaceId: space,
            role: role.startsWith("preset:")
              ? { kind: "preset", preset: role.slice("preset:".length) as SpaceRolePreset }
              : { kind: "custom", roleId: role.slice("custom:".length) },
          },
  };
}

/**
 * Steps 2–5 of the plan's §4.2, free of Hono: `onDenial` is a parameter because
 * SSE runs outside the pipeline; `scopeCeiling` stops a credential previewing a
 * role it could not grant.
 */
export async function validateViewAs(input: {
  raw: string | undefined;
  orgId: string;
  realOrgRole: OrgRole;
  scopeCeiling?: ReadonlySet<string>;
  onDenial: (required: string) => void;
}): Promise<ViewAsPersona | undefined> {
  const { raw, orgId, realOrgRole, scopeCeiling, onDenial } = input;
  const request = parseViewAs(raw);
  if (!request) return undefined;

  if (realOrgRole !== "owner" && realOrgRole !== "admin") {
    // Audited like any other refusal, so a member probing the header is visible.
    onDenial(`view_as:${request.orgRole}`);
    throw viewAsForbidden("Only an organization owner or administrator can preview a role.");
  }

  return {
    orgId,
    orgRole: request.orgRole,
    space: request.space
      ? await validatePersonaSpace(request.space, orgId, realOrgRole, scopeCeiling, onDenial)
      : null,
  };
}

async function validatePersonaSpace(
  requested: NonNullable<ViewAsRequest["space"]>,
  orgId: string,
  realOrgRole: OrgRole,
  scopeCeiling: ReadonlySet<string> | undefined,
  onDenial: (required: string) => void,
): Promise<NonNullable<ViewAsPersona["space"]>> {
  const space = await validateSpaceInOrg(requested.spaceId, orgId);
  if (!space) throw viewAsNotFound(`Space '${requested.spaceId}' not found in this organization`);
  const role = await resolvePersonaSpaceRole(orgId, requested.role);
  // Grantability against what the real caller holds THERE — the same rule that
  // gates handing the role to someone else. Owners and admins never carry a
  // `space_members` row, so `null` IS their row.
  const real = effectivePermissions({
    orgPermissions: orgPermissions(realOrgRole),
    spacePermissions: spacePermissions(resolveSpaceRole(realOrgRole, space, null)),
    scopeCeiling,
  });
  if (!canGrantSpaceRole(real, role)) {
    onDenial(`view_as:${requested.role.kind}`);
    throw viewAsForbidden(
      `You cannot preview a role that grants permissions you do not hold in space '${space.id}'.`,
    );
  }
  return { spaceId: space.id, role };
}

/**
 * Feature gate first: with `custom_roles` off there is no bundle vocabulary to
 * look in. Same predicate as the role routes ({@link hasCustomRoles}), a
 * different refusal — every way a persona can be turned down has to be a code
 * the client recognizes as "drop the preview".
 */
async function resolvePersonaSpaceRole(
  orgId: string,
  ref: PersonaRoleRequest,
): Promise<SpaceRoleRef> {
  if (ref.kind === "preset") return { kind: "preset", preset: ref.preset };
  if (!hasCustomRoles()) {
    throw viewAsForbidden(
      "Previewing a custom space role requires the `custom_roles` feature, provided by the " +
        "Appstrate Cloud plan (the `@appstrate/cloud` module). The four built-in presets " +
        "(admin, builder, operator, viewer) are always previewable.",
    );
  }
  const [row] = await db
    .select()
    .from(spaceRoles)
    .where(and(eq(spaceRoles.id, ref.roleId), eq(spaceRoles.orgId, orgId)))
    .limit(1);
  if (!row) throw viewAsNotFound(`Role '${ref.roleId}' not found in this organization`);
  return {
    kind: "custom",
    role: { id: row.id, key: row.key, name: row.name, permissions: row.permissions },
  };
}

// ─── Carriers ──────────────────────────────────────────────────────────────

/**
 * Eligibility at the earliest point the header can be judged: a key or bearer
 * carries its own ceiling and no session to narrow. The marker goes after the
 * handler; refusals get it from `errorHandler`, which builds a fresh response.
 * Who reads that marker: {@link VIEW_AS_ACTIVE_HEADER}.
 */
export function viewAsTransportGuard() {
  return async (c: Context<AppEnv>, next: Next) => {
    const header = c.req.header(VIEW_AS_HEADER);
    if (header !== undefined) {
      if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) {
        throw new ApiError({
          status: 400,
          code: "view_as_unsupported",
          title: "View-As Not Supported",
          detail:
            `${VIEW_AS_HEADER} is only supported for a user session or the CLI/instance ` +
            `token, not for ${c.get("authMethod") ?? "this"} authentication.`,
          param: VIEW_AS_HEADER,
        });
      }
      parseViewAs(header);
    }
    await next();
    if (c.get("viewAs")) c.header(VIEW_AS_ACTIVE_HEADER, "1");
  };
}

/** Must run before any `permissions` write: every write site reads the persona. */
export async function resolveViewAs(
  c: Context<AppEnv>,
  orgId: string,
  realOrgRole: OrgRole,
): Promise<ViewAsPersona | undefined> {
  const resolved = c.get("viewAs");
  if (resolved) return resolved;
  const persona = await validateViewAs({
    raw: c.req.header(VIEW_AS_HEADER),
    orgId,
    realOrgRole,
    scopeCeiling: c.get("scopeCeiling"),
    onDenial: (required) => reportPermissionDenial(c, required),
  });
  if (persona) c.set("viewAs", persona);
  return persona;
}

/**
 * The org listings skip `requireOrgContext`, so `X-Org-Id` names the previewed
 * org. Refusals rather than a silent pass: real permissions returned to a
 * client that believes it is previewing is the failure mode to avoid.
 */
export async function resolveListingViewAs(
  c: Context<AppEnv>,
  orgs: ReadonlyArray<{ id: string; role: OrgRole }>,
): Promise<void> {
  if (c.req.header(VIEW_AS_HEADER) === undefined) return;
  const orgId = c.get("orgId") ?? c.req.header("X-Org-Id");
  if (!orgId) {
    throw invalidViewAs(
      `${VIEW_AS_HEADER} names no organization on this operation. Send X-Org-Id alongside it to say which organization the role is previewed in.`,
    );
  }
  const row = orgs.find((org) => org.id === orgId);
  if (!row) throw viewAsNotFound(`Organization '${orgId}' not found`);
  await resolveViewAs(c, orgId, row.role);
}

/**
 * ADOPTED, not re-validated: HMAC-signed with a process-local secret, minted
 * from a request the pipeline already validated (the trust `claims.permissions`
 * gets), and the hop's ceiling IS the persona's set so re-validating would ask
 * the wrong question. `"viewAs"` is a literal on both ends — apps/api →
 * module-chat, so the writer cannot import from here — and a rename that misses
 * one end fails the loopback integration test.
 */
export function adoptViewAs(
  c: Context<AppEnv>,
  orgId: string | undefined,
  extra: Record<string, unknown> | undefined,
): void {
  const raw = extra?.viewAs;
  if (raw === undefined) return;
  const parsed = personaSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidViewAs("The loopback bearer carries a role preview this server cannot read.");
  }
  // A persona applies in ONE org. Publishing one minted for another would stamp
  // `X-View-As-Active` on a response no persona shaped — every accessor here is
  // already org-keyed, so the set would narrow nothing and only mislead.
  if (parsed.data.orgId !== orgId) return;
  c.set("viewAs", parsed.data);
}

// ─── Applying a persona ────────────────────────────────────────────────────

/** The persona in force for `orgId` — `undefined` in every other org. */
export function personaFor(c: Context<AppEnv>, orgId: string): ViewAsPersona | undefined {
  const persona = c.get("viewAs");
  return persona?.orgId === orgId ? persona : undefined;
}

/**
 * The org half of `permissions`, for every site that writes it: the caller's
 * role grants ∪ their principal grants, replaced under a preview by the
 * persona's role grants INTERSECTED with that. A persona takes no principal
 * grants of its own (those are the administrator's), but the set it is
 * intersected with keeps them, so a preview can never exceed the caller.
 *
 * One helper, so a persona cannot apply on some paths and not others.
 */
export function orgHalfFor(
  c: Context<AppEnv>,
  orgId: string | undefined,
  role: OrgRole,
  principal?: ReadonlySet<string>,
): { orgPermissions: Set<string>; effective: Set<string> } {
  const fromRole = orgPermissions(role);
  // Allocate a second Set only when a module actually granted something — with
  // no such module the OSS path keeps the exact shape it had.
  const real: Set<string> =
    principal && principal.size > 0 ? new Set<string>([...fromRole, ...principal]) : fromRole;
  const persona = orgId === undefined ? undefined : personaFor(c, orgId);
  let org = real;
  if (persona) {
    org = new Set<string>();
    for (const permission of orgPermissions(persona.orgRole)) {
      if (real.has(permission)) org.add(permission);
    }
  }
  return {
    orgPermissions: org,
    effective: effectivePermissions({ orgPermissions: org, scopeCeiling: c.get("scopeCeiling") }),
  };
}

/** What this caller reaches in `orgId`; `c.get("orgRole")` stays real. */
export function callerOrgRole(c: Context<AppEnv>, orgId = c.get("orgId")): OrgRole {
  return personaFor(c, orgId)?.orgRole ?? c.get("orgRole");
}

/** Its own row, or none anywhere else. Exported for SSE, which has no `c.get("user")`. */
export function personaSpaceMember(persona: ViewAsPersona, spaceId: string): SpaceMemberRow | null {
  return persona.space?.spaceId === spaceId ? { ref: persona.space.role } : null;
}

/** The caller's row in one space, replaced by the persona overlay while previewing. */
export async function callerSpaceMember(
  c: Context<AppEnv>,
  orgId: string,
  spaceId: string,
): Promise<SpaceMemberRow | null> {
  const persona = personaFor(c, orgId);
  if (persona) return personaSpaceMember(persona, spaceId);
  return loadSpaceMember(spaceId, c.get("user").id);
}

/** The `listSpacesForPrincipal` overlay, so a preview never reads the caller's own rows. */
export function personaMemberships(
  persona: ViewAsPersona | undefined,
): Map<string, SpaceMemberRow> | undefined {
  if (!persona) return undefined;
  const overlay = new Map<string, SpaceMemberRow>();
  if (persona.space) overlay.set(persona.space.spaceId, { ref: persona.space.role });
  return overlay;
}

/** {@link personaMemberships} for a caller that must always get a map. */
export async function callerSpaceMemberships(
  c: Context<AppEnv>,
  orgId: string,
): Promise<Map<string, SpaceMemberRow>> {
  return (
    personaMemberships(personaFor(c, orgId)) ??
    (await loadSpaceMemberships(orgId, c.get("user").id))
  );
}

/** Snake_case snapshot, as audit rows and denial records carry it. */
export function viewAsWire(persona: ViewAsPersona): Record<string, unknown> {
  return {
    org_role: persona.orgRole,
    space: persona.space
      ? { space_id: persona.space.spaceId, role: toSpaceRoleWire(persona.space.role) }
      : null,
  };
}
