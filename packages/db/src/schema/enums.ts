// SPDX-License-Identifier: Apache-2.0

/**
 * Co-located Drizzle `pgEnum` + Zod `z.enum` definitions. Each value
 * list is declared once as a `const` tuple and re-used for both —
 * adding a value updates the DB enum, the Zod validator, and the
 * inferred TS union in lockstep.
 *
 * Only `zDocumentPurposeEnum` still exists as a Zod validator, because
 * `routes/documents.ts` actually parses with it. Eight sibling `z*Enum`
 * validators used to live here under a header telling route handlers to import
 * them instead of redeclaring literal arrays inline — in the years since, not
 * one route ever did, and they had zero consumers across all four repos. The
 * `*Values` tuples below are the real shared surface; a type union derives from
 * a tuple directly (`(typeof xValues)[number]`) without a Zod object in
 * between. Add a `z*Enum` here when a route genuinely needs to parse the value,
 * not pre-emptively.
 */

import { z } from "zod";
import { pgEnum } from "drizzle-orm/pg-core";
import { runStatusValues } from "../run-status.ts";

export const orgRoleValues = ["owner", "admin", "member", "viewer"] as const;
export const orgRoleEnum = pgEnum("org_role", orgRoleValues);
export type OrgRole = (typeof orgRoleValues)[number];

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

export const invitationStatusValues = ["pending", "accepted", "expired", "cancelled"] as const;
export const invitationStatusEnum = pgEnum("invitation_status", invitationStatusValues);

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
export type PackageType = (typeof packageTypeValues)[number];

export const packageSourceValues = ["local", "system"] as const;
export const packageSourceEnum = pgEnum("package_source", packageSourceValues);

/**
 * Source discriminator for `llm_usage` rows. Each source has its own
 * dedup key: `proxy` rows dedup on `request_id`, `runner` rows dedup on
 * `(run_id, sequence)`.
 */
export const llmUsageSourceValues = ["proxy", "runner"] as const;
export const llmUsageSourceEnum = pgEnum("llm_usage_source", llmUsageSourceValues);

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
export type CredentialSource = (typeof credentialSourceValues)[number];

/**
 * Distinguishes WHO controls the runner process — `platform` for
 * platform-managed Pi containers, `remote` for caller-managed runners
 * (CLI, GitHub Action, self-hosted). Closed set: every event-ingestion
 * code path branches on it, so adding a value is intentional.
 */
export const runOriginValues = ["platform", "remote"] as const;
export const runOriginEnum = pgEnum("run_origin", runOriginValues);

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
