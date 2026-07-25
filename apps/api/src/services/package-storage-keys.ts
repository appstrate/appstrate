// SPDX-License-Identifier: Apache-2.0

/**
 * Object-key layout of the `agent-packages` bucket (published version ZIPs).
 *
 * This module is a LEAF: pure strings, no I/O, no service imports. Both the
 * writer (`package-storage.ts`, which pulls the whole AFPS bundle/catalog
 * graph) and the deletion/reconciliation paths (`package-storage-deletion.ts`,
 * `storage-orphans.ts`, reached from `organizations.ts`) need the layout, and
 * routing them through `package-storage.ts` would drag that heavy graph into
 * the org-deletion transaction path. Same reasoning as
 * `run-workspace-manifest.ts`.
 *
 * ONE definition of the key means the outbox job, the orphan scanner's
 * known-set and the upload all derive the same string — a deletion job aimed
 * at a key the writer never wrote deletes nothing and still looks green.
 */

/** Bucket holding every published package version artifact. */
export const AGENT_PACKAGES_BUCKET = "agent-packages";

/**
 * In-bucket key of a published version artifact: `{packageId}/{version}.afps`.
 *
 * `packageId` is the `@scope/name` id, which is the PRIMARY KEY of `packages`
 * — globally unique across the whole platform, so this key space is
 * unambiguously owned by exactly one `packages` row (and therefore by exactly
 * one org, or by the system catalog when that row's `orgId` is null). Two orgs
 * can never contend for the same key.
 */
export const versionZipKey = (packageId: string, version: string): string =>
  `${packageId}/${version}.afps`;
