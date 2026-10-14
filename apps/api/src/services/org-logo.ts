// SPDX-License-Identifier: Apache-2.0

/**
 * Organization logo — one emoji, or one WebP image kept in object storage.
 *
 * `organizations.logo` stores `emoji:<grapheme>`, `image:<version>` or null; the wire
 * carries it as an `OrgLogo` (`orgLogoWire`). An image's bytes live at
 * `orgs/{orgId}/logo.webp` and never in the row; the version is a digest of those
 * bytes, so the URL served for it changes with the image and
 * `GET /api/orgs/{orgId}/logo` can answer with the version as `ETag`.
 *
 * Every write locks the organization row and does its storage I/O inside that
 * transaction. The key is the same for every image of an org, so two unserialized
 * writes could let one request delete the bytes the other just wrote; under the lock,
 * the row and the object always change together. The object is a few KiB, so the lock
 * is short.
 */

import { eq, like } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import {
  uploadFile as storageUpload,
  downloadFile as storageDownload,
  deleteFile as storageDelete,
} from "@appstrate/db/storage";
import type { StorageDeletionJobInput } from "./storage-deletion.ts";

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
export function orgLogoKey(orgId: string): string {
  return `${orgId}/${LOGO_FILE}`;
}

/** The org owning an in-bucket key, or null when the key is not a logo key. */
export function orgLogoKeyOwner(key: string): string | null {
  const suffix = `/${LOGO_FILE}`;
  if (!key.endsWith(suffix)) return null;
  const orgId = key.slice(0, -suffix.length);
  return orgId && !orgId.includes("/") ? orgId : null;
}

/** The outbox job purging an org's logo image. A missing object is a no-op delete. */
export function orgLogoDeletionJob(orgId: string, reason: string): StorageDeletionJobInput {
  return { bucket: ORG_LOGO_BUCKET, storageKey: orgLogoKey(orgId), reason };
}

/** Ids of the orgs whose logo is an image — the objects the bucket should hold. */
export async function orgIdsWithLogoImage(): Promise<Set<string>> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(like(organizations.logo, `${IMAGE_PREFIX}%`));
  return new Set(rows.map((r) => r.id));
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
 * nothing. Replacing an image with anything but an image deletes its bytes.
 */
export async function setOrgLogo(
  orgId: string,
  next: { image: Uint8Array } | { emoji: string } | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ logo: organizations.logo })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!current) throw new Error("Failed to update organization logo: not found");

    let logo: string | null = null;
    if (next && "image" in next) {
      await storageUpload(ORG_LOGO_BUCKET, orgLogoKey(orgId), next.image);
      const version = new Bun.CryptoHasher("sha256").update(next.image).digest("hex").slice(0, 16);
      logo = `${IMAGE_PREFIX}${version}`;
    } else if (next) {
      logo = `${EMOJI_PREFIX}${next.emoji}`;
    }

    await tx
      .update(organizations)
      .set({ logo, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));

    if (logoImageVersion(current.logo) && !logoImageVersion(logo)) {
      await storageDelete(ORG_LOGO_BUCKET, orgLogoKey(orgId));
    }
  });
}

/** The bytes of an organization's logo image, null when it has none. */
export function readOrgLogoImage(orgId: string): Promise<Uint8Array | null> {
  return storageDownload(ORG_LOGO_BUCKET, orgLogoKey(orgId));
}
