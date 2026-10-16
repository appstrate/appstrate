// SPDX-License-Identifier: Apache-2.0

/**
 * Organization logo — one emoji, or one WebP image kept in object storage.
 *
 * `organizations.logo` stores `emoji:<grapheme>`, `image:<version>` or null; the wire
 * carries it as an `OrgLogo` (`orgLogoWire`). An image's bytes live at
 * `orgs/{orgId}/logo-{version}.webp` and never in the row; every upload gets a
 * new immutable key, so the URL served for it changes with the image and
 * `GET /api/orgs/{orgId}/logo` can answer with the version as `ETag`.
 *
 * Writers serialize on the organization row, upload BEFORE publishing its pointer,
 * and enqueue the previous key's deletion in that transaction. A rollback leaves
 * the previous bytes intact. Failed uploads/publications are queued for cleanup;
 * orphan reconciliation covers a process crash. Existing digest versions keep
 * reading the legacy `logo.webp` key until the next successful replacement.
 */

import { eq, like } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import {
  uploadFile as storageUpload,
  downloadFile as storageDownload,
} from "@appstrate/db/storage";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import { logger } from "../lib/logger.ts";

export const ORG_LOGO_BUCKET = "orgs";

const EMOJI_PREFIX = "emoji:";
const IMAGE_PREFIX = "image:";

/** An organization logo on the wire: one emoji, or the URL of its uploaded image. */
export type OrgLogo = { kind: "emoji"; emoji: string } | { kind: "image"; url: string };

/**
 * The wire form of a stored logo. An image's URL names its version, so it is a new
 * URL whenever the image changes and the response to it can be cached for good.
 */
export function orgLogoWire(orgId: string, stored: string | null): OrgLogo | null {
  if (stored?.startsWith(EMOJI_PREFIX)) {
    return { kind: "emoji", emoji: stored.slice(EMOJI_PREFIX.length) };
  }
  const version = logoImageVersion(stored);
  if (!version) return null;
  return {
    kind: "image",
    url: `/api/orgs/${encodeURIComponent(orgId)}/logo?v=${encodeURIComponent(version)}`,
  };
}

const LOGO_FILE = "logo.webp";

/** In-bucket key of an organization's logo image. */
export function orgLogoKey(orgId: string, version: string): string {
  return /^[0-9a-f]{16}$/.test(version) ? `${orgId}/${LOGO_FILE}` : `${orgId}/logo-${version}.webp`;
}

/** Recognized logo keys only; unknown objects are never orphan-purged. */
export function orgLogoStorageKey(key: string): string | null {
  return /^[^/]+\/logo(?:-[0-9a-f-]{36})?\.webp$/.test(key) ? key : null;
}

/** The outbox job purging an org's logo image. A missing object is a no-op delete. */
export function orgLogoDeletionJob(
  orgId: string,
  version: string,
  reason: string,
): StorageDeletionJobInput {
  return { bucket: ORG_LOGO_BUCKET, storageKey: orgLogoKey(orgId, version), reason };
}

/** The exact live keys, so obsolete versions of a live org are still orphans. */
export async function orgLogoStorageKeys(): Promise<Set<string>> {
  const rows = await db
    .select({ id: organizations.id, logo: organizations.logo })
    .from(organizations)
    .where(like(organizations.logo, `${IMAGE_PREFIX}%`));
  return new Set(rows.map((r) => orgLogoKey(r.id, logoImageVersion(r.logo)!)));
}

/** A failed commit may have succeeded remotely; never purge a still-published key. */
export async function deleteOrgLogoUnlessReferenced(
  key: string,
  del: () => Promise<void>,
): Promise<"deleted" | "reclaimed"> {
  const orgId = orgLogoStorageKey(key)?.split("/")[0];
  if (!orgId) {
    await del();
    return "deleted";
  }
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ logo: organizations.logo })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("no key update");
    const version = logoImageVersion(org?.logo ?? null);
    if (version && orgLogoKey(orgId, version) === key) return "reclaimed";
    await del();
    return "deleted";
  });
}

/** Whether `bytes` is a WebP file: a RIFF container whose form type is `WEBP`. */
export function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

/** The version of an `image:` logo, null for an emoji or no logo. */
export function logoImageVersion(logo: string | null): string | null {
  return logo?.startsWith(IMAGE_PREFIX) ? logo.slice(IMAGE_PREFIX.length) : null;
}

/**
 * Replace the organization logo: an image (validated WebP bytes), one emoji, or
 * nothing. Obsolete bytes are deleted by the transactional storage outbox.
 */
export async function setOrgLogo(
  orgId: string,
  next: { image: Uint8Array } | { emoji: string } | null,
): Promise<void> {
  const version = next && "image" in next ? crypto.randomUUID() : null;
  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ logo: organizations.logo })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1)
        .for("no key update");
      if (!current) throw new Error("Failed to update organization logo: not found");

      let logo: string | null = null;
      if (next && "image" in next) {
        await storageUpload(ORG_LOGO_BUCKET, orgLogoKey(orgId, version!), next.image);
        logo = `${IMAGE_PREFIX}${version}`;
      } else if (next) {
        logo = `${EMOJI_PREFIX}${next.emoji}`;
      }

      await tx
        .update(organizations)
        .set({ logo, updatedAt: new Date() })
        .where(eq(organizations.id, orgId));

      const previous = logoImageVersion(current.logo);
      if (previous) {
        await enqueueStorageDeletion(tx, orgLogoDeletionJob(orgId, previous, "org_logo_replaced"));
      }
    });
  } catch (error) {
    if (version) {
      await enqueueStorageDeletion(db, orgLogoDeletionJob(orgId, version, "org_logo_failed")).catch(
        (cleanupError) =>
          logger.error("Failed to enqueue unpublished logo cleanup", {
            orgId,
            version,
            error: cleanupError,
          }),
      );
    }
    throw error;
  }
}

/** The bytes of an organization's logo image, null when it has none. */
export function readOrgLogoImage(orgId: string, version: string): Promise<Uint8Array | null> {
  return storageDownload(ORG_LOGO_BUCKET, orgLogoKey(orgId, version));
}
