// SPDX-License-Identifier: Apache-2.0

/**
 * Co-located Drizzle `pgEnum` + Zod `z.enum` definitions. Each value
 * list is declared once as a `const` tuple and re-used for both —
 * adding a value updates the DB enum, the Zod validator, and the
 * inferred TS union in lockstep.
 *
 * Route handlers should import the `z*Enum` siblings from
 * `@appstrate/db/schema` (e.g. `zRunStatusEnum`) instead of
 * redeclaring literal arrays inline.
 */

import { z } from "zod";
import { pgEnum } from "drizzle-orm/pg-core";
import { runStatusValues } from "../run-status.ts";

export const orgRoleValues = ["owner", "admin", "member", "viewer"] as const;
export const orgRoleEnum = pgEnum("org_role", orgRoleValues);
export const zOrgRoleEnum = z.enum(orgRoleValues);
export type OrgRole = z.infer<typeof zOrgRoleEnum>;

/**
 * Run statuses are the one enum whose literals live OUTSIDE this file, in the
 * import-free `../run-status.ts`: the SPA needs the values (not the Drizzle
 * object), and importing them from here would pull drizzle-orm + the whole
 * schema barrel into the browser bundle. The `pgEnum` below derives from that
 * tuple, so the DB enum can never drift from what the client ships.
 */
export {
  runStatusValues,
  terminalRunStatusValues,
  TERMINAL_RUN_STATUSES,
  activeRunStatusValues,
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_EVENT_TYPES,
} from "../run-status.ts";
export type { RunStatus, TerminalRunStatus } from "../run-status.ts";

export const runStatusEnum = pgEnum("run_status", runStatusValues);
export const zRunStatusEnum = z.enum(runStatusValues);

export const invitationStatusValues = ["pending", "accepted", "expired", "cancelled"] as const;
export const invitationStatusEnum = pgEnum("invitation_status", invitationStatusValues);
export const zInvitationStatusEnum = z.enum(invitationStatusValues);

export const packageTypeValues = [
  "agent",
  "skill",
  "integration",
  // AFPS §3.4 — a standalone MCP Bundle (MCPB) package that an
  // integration's `source.kind: "local"` references via `source.server`.
  // The integration carries the auth/scope/delivery contract; the mcp-server
  // package carries the runnable server (entry point + runtime).
  "mcp-server",
] as const;
export const packageTypeEnum = pgEnum("package_type", packageTypeValues);
export const zPackageTypeEnum = z.enum(packageTypeValues);
export type PackageType = z.infer<typeof zPackageTypeEnum>;

export const packageSourceValues = ["local", "system"] as const;
export const packageSourceEnum = pgEnum("package_source", packageSourceValues);
export const zPackageSourceEnum = z.enum(packageSourceValues);

/**
 * Source discriminator for `llm_usage` rows. Each source has its own
 * dedup key: `proxy` rows dedup on `request_id`, `runner` rows dedup on
 * `(run_id, sequence)`.
 */
export const llmUsageSourceValues = ["proxy", "runner"] as const;
export const llmUsageSourceEnum = pgEnum("llm_usage_source", llmUsageSourceValues);
export const zLlmUsageSourceEnum = z.enum(llmUsageSourceValues);

/**
 * Which credential set reached the upstream provider for an `llm_usage`
 * row — `system` for platform-provided model credentials, `org` for the
 * organization's own key or subscription. Attribution only: the OSS
 * platform records who paid the provider, never how that maps to any
 * downstream accounting. Nullable on the column (historical rows may
 * predate it); every new row is stamped.
 */
export const credentialSourceValues = ["system", "org"] as const;
export const credentialSourceEnum = pgEnum("credential_source", credentialSourceValues);
export const zCredentialSourceEnum = z.enum(credentialSourceValues);
export type CredentialSource = z.infer<typeof zCredentialSourceEnum>;

/**
 * Distinguishes WHO controls the runner process — `platform` for
 * platform-managed Pi containers, `remote` for caller-managed runners
 * (CLI, GitHub Action, self-hosted). Closed set: every event-ingestion
 * code path branches on it, so adding a value is intentional.
 */
export const runOriginValues = ["platform", "remote"] as const;
export const runOriginEnum = pgEnum("run_origin", runOriginValues);
export const zRunOriginEnum = z.enum(runOriginValues);

/**
 * What a `documents` row is: `user_upload` (a staged upload materialized into
 * durable storage when consumed by a run/chat session) or `agent_output` (a
 * deliverable an agent published from a run). Drives the `downloadable`
 * derivation — an agent output is served to any actor who can read the
 * container, a user upload only to its own creator.
 */
export const documentPurposeValues = ["user_upload", "agent_output"] as const;
export const documentPurposeEnum = pgEnum("document_purpose", documentPurposeValues);
export const zDocumentPurposeEnum = z.enum(documentPurposeValues);
export type DocumentPurpose = z.infer<typeof zDocumentPurposeEnum>;
