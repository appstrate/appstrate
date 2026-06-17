// SPDX-License-Identifier: Apache-2.0

/**
 * Storage API — disks (native default + connected cloud) and objects, with
 * upload/download/delete and on-demand cloud sync.
 *
 * The opaque object `id` is the contract: chat attachments, agents and the
 * future search index hold it and read bytes by it (`GET /objects/:id
 * /content`) — never the disk's internal `driverKey`. storage owns the object
 * ACL (`visibility`/`ownerId`); inventory and reads apply the same filter.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { storageDisks, storageObjects } from "@appstrate/db/schema";
import { requireModulePermission } from "@appstrate/core/permissions";
import { invalidRequest, notFound, parseBody } from "@appstrate/core/api-errors";
import { encrypt } from "@appstrate/connect";
import {
  ensureDefaultDisk,
  makeDriverContext,
  newId,
  syncDisk,
  type RequestActor,
} from "./service.ts";
import { isCloudKind, resolveDriver } from "./drivers/index.ts";
import { emitStorageObjectEvent } from "./events.ts";
import { logger } from "./logger.ts";

type StorageEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    orgId: string;
  };
};

/** The calling member as a credential-proxy actor (Drive disks use it). */
function actorOf(c: { get: (k: "user") => { id: string } }): RequestActor {
  return { type: "user", id: c.get("user").id };
}

const s3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().optional(),
  endpoint: z.url().optional(),
  force_path_style: z.boolean().optional(),
  prefix: z.string().optional(),
  access_key_id: z.string().min(1),
  /** Encrypted at rest with the platform CONNECTION_ENCRYPTION_KEY. */
  secret_access_key: z.string().min(1),
});

const gdriveConfigSchema = z.object({
  /** Integration package id of the picked connection (e.g. `@appstrate/google-drive`). */
  integration_id: z.string().min(1),
  /** The integration connection the user picked (their existing Drive grant). */
  connection_id: z.string().min(1),
  /** Application the connection lives in (proxy credential scope). */
  application_id: z.string().min(1),
  /** Mandatory scoping — never the whole Drive (appstrate-ws rule). */
  folder_ids: z.array(z.string().min(1)).min(1),
});

export const createDiskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("s3"), name: z.string().min(1).max(200), config: s3ConfigSchema }),
  z.object({
    kind: z.literal("google_drive"),
    name: z.string().min(1).max(200),
    config: gdriveConfigSchema,
  }),
]);

export const uploadObjectSchema = z.object({
  /** Target disk; defaults to the org's native default disk. */
  diskId: z.string().optional(),
  /** Overrides the uploaded file's name. */
  name: z.string().min(1).max(500).optional(),
  /** `org` (default) = visible to every member; `private` = owner only. */
  visibility: z.enum(["org", "private"]).default("org"),
});

/**
 * Seal secret config fields before persisting. Only S3 carries a secret here;
 * Drive holds no credentials — it references a platform integration connection
 * (the credential-proxy injects the token at call time).
 */
function sealDiskConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  if (kind === "s3") {
    return { ...config, secret_access_key: encrypt(String(config.secret_access_key)) };
  }
  return config;
}

type DiskRow = typeof storageDisks.$inferSelect;
type ObjectRow = typeof storageObjects.$inferSelect;

function toDiskDto(row: DiskRow) {
  return {
    object: "storage_disk" as const,
    id: row.id,
    kind: row.kind,
    name: row.name,
    isDefault: row.isDefault,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toObjectDto(row: ObjectRow) {
  return {
    object: "storage_object" as const,
    id: row.id,
    diskId: row.diskId,
    name: row.name,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    visibility: row.visibility,
    ownerId: row.ownerId,
    syncedAt: row.syncedAt ? row.syncedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// MIME types a browser may execute as script when rendered inline — served as
// a non-rendering download instead (see the content route). Covers HTML/XHTML,
// SVG (carries inline <script>), and XML (XSLT / namespaced scriptable docs).
const SCRIPTABLE_MIME =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml)\b/i;

/** Inventory/read ACL: org-visible objects, plus the caller's private ones. */
function objectAclWhere(orgId: string, userId: string) {
  return and(
    eq(storageObjects.orgId, orgId),
    or(
      eq(storageObjects.visibility, "org"),
      and(eq(storageObjects.visibility, "private"), eq(storageObjects.ownerId, userId)),
    ),
  );
}

/** Load one object the caller may access (org-visible or their own private), or 404. */
async function loadAccessibleObject(id: string, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(storageObjects)
    .where(and(eq(storageObjects.id, id), objectAclWhere(orgId, userId)))
    .limit(1);
  if (!row) throw notFound("Storage object not found");
  return row;
}

// ---------------------------------------------------------------------------
// Rate limiting — injected platform capability (set by index.ts at init).
// Before init (or on platforms without it) routes run unlimited.
// ---------------------------------------------------------------------------

type RateLimitFactory = (limitPerMinute: number) => MiddlewareHandler;
let rateLimitFactory: RateLimitFactory | null = null;

export function setRateLimitFactory(factory: RateLimitFactory | null): void {
  rateLimitFactory = factory;
}

function rateLimited(limitPerMinute: number): MiddlewareHandler {
  return (c, next) => (rateLimitFactory ? rateLimitFactory(limitPerMinute)(c, next) : next());
}

export function createStorageRouter() {
  const router = new Hono<StorageEnv>();

  // GET /api/storage/disks — list disks (ensures the native default exists)
  router.get("/api/storage/disks", requireModulePermission("storage", "read"), async (c) => {
    const orgId = c.get("orgId");
    await ensureDefaultDisk(orgId);
    const rows = await db
      .select()
      .from(storageDisks)
      .where(eq(storageDisks.orgId, orgId))
      .orderBy(desc(storageDisks.isDefault), desc(storageDisks.createdAt));
    return c.json({ object: "list", data: rows.map(toDiskDto), hasMore: false });
  });

  // POST /api/storage/disks — connect a cloud disk (secrets encrypted at
  // rest; the initial sync runs synchronously so objects show up at once).
  router.post(
    "/api/storage/disks",
    rateLimited(10),
    requireModulePermission("storage", "manage"),
    async (c) => {
      const orgId = c.get("orgId");
      const data = parseBody(createDiskSchema, await c.req.json());
      const [row] = await db
        .insert(storageDisks)
        .values({
          id: newId("sdsk"),
          orgId,
          kind: data.kind,
          name: data.name,
          config: sealDiskConfig(data.kind, data.config as Record<string, unknown>),
        })
        .returning();
      await syncDisk(row!.id, orgId, actorOf(c), logger).catch((err) =>
        logger.warn("initial disk sync failed", { diskId: row!.id, err: String(err) }),
      );
      return c.json(toDiskDto(row!), 201);
    },
  );

  // POST /api/storage/disks/:id/sync — synchronous cloud sync (list → upsert)
  router.post(
    "/api/storage/disks/:id/sync",
    rateLimited(10),
    requireModulePermission("storage", "manage"),
    async (c) => {
      const orgId = c.get("orgId");
      const [disk] = await db
        .select({ id: storageDisks.id, kind: storageDisks.kind })
        .from(storageDisks)
        .where(and(eq(storageDisks.id, c.req.param("id")), eq(storageDisks.orgId, orgId)))
        .limit(1);
      if (!disk) throw notFound("Storage disk not found");
      if (!isCloudKind(disk.kind)) {
        throw invalidRequest(`disk kind "${disk.kind}" cannot be synced`);
      }
      const result = await syncDisk(disk.id, orgId, actorOf(c), logger);
      return c.json({ object: "disk_sync", diskId: disk.id, ...result });
    },
  );

  // DELETE /api/storage/disks/:id — disconnect (objects cascade). The native
  // default disk cannot be deleted.
  router.delete(
    "/api/storage/disks/:id",
    requireModulePermission("storage", "manage"),
    async (c) => {
      const orgId = c.get("orgId");
      const [disk] = await db
        .select({ id: storageDisks.id, isDefault: storageDisks.isDefault })
        .from(storageDisks)
        .where(and(eq(storageDisks.id, c.req.param("id")), eq(storageDisks.orgId, orgId)))
        .limit(1);
      if (!disk) throw notFound("Storage disk not found");
      if (disk.isDefault) throw invalidRequest("The default disk cannot be deleted");
      await db.delete(storageDisks).where(eq(storageDisks.id, disk.id));
      return c.body(null, 204);
    },
  );

  // GET /api/storage/objects — inventory (filterable by disk, ACL applied)
  router.get("/api/storage/objects", requireModulePermission("storage", "read"), async (c) => {
    const diskId = c.req.query("diskId");
    const acl = objectAclWhere(c.get("orgId"), c.get("user").id);
    const rows = await db
      .select()
      .from(storageObjects)
      .where(diskId ? and(acl, eq(storageObjects.diskId, diskId)) : acl)
      .orderBy(desc(storageObjects.updatedAt))
      .limit(200);
    return c.json({ object: "list", data: rows.map(toObjectDto), hasMore: false });
  });

  // POST /api/storage/objects — upload a file (multipart) to a writable disk
  // (the native default unless `diskId` is given).
  router.post(
    "/api/storage/objects",
    rateLimited(30),
    requireModulePermission("storage", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File))
        throw invalidRequest("multipart field `file` is required", "file");
      const meta = parseBody(uploadObjectSchema, {
        diskId: typeof form.diskId === "string" ? form.diskId : undefined,
        name: typeof form.name === "string" ? form.name : undefined,
        visibility: typeof form.visibility === "string" ? form.visibility : undefined,
      });

      const diskId = meta.diskId ?? (await ensureDefaultDisk(orgId));
      const [disk] = await db
        .select()
        .from(storageDisks)
        .where(and(eq(storageDisks.id, diskId), eq(storageDisks.orgId, orgId)))
        .limit(1);
      if (!disk) throw notFound("Storage disk not found");

      const driver = resolveDriver(disk);
      if (!driver.write) throw invalidRequest(`disk kind "${disk.kind}" is read-only`);

      const name = meta.name ?? file.name;
      const mime = file.type || "application/octet-stream";
      const bytes = new Uint8Array(await file.arrayBuffer());
      const driverKey = await driver.write(name, mime, bytes);

      const [row] = await db
        .insert(storageObjects)
        .values({
          id: newId("sobj"),
          orgId,
          diskId,
          driverKey,
          name,
          mime,
          sizeBytes: bytes.byteLength,
          visibility: meta.visibility,
          ownerId: c.get("user").id,
          syncedAt: new Date(),
        })
        .returning();

      emitStorageObjectEvent({
        type: "object.upserted",
        id: row!.id,
        orgId,
        diskId,
        mime,
        acl: { visibility: row!.visibility, ownerId: row!.ownerId },
      });
      return c.json(toObjectDto(row!), 201);
    },
  );

  // GET /api/storage/objects/:id — object metadata (ACL applied)
  router.get("/api/storage/objects/:id", requireModulePermission("storage", "read"), async (c) => {
    const row = await loadAccessibleObject(c.req.param("id"), c.get("orgId"), c.get("user").id);
    return c.json(toObjectDto(row));
  });

  // GET /api/storage/objects/:id/content — download raw bytes by id (the read
  // seam: chat/agents/search reach the bytes here, never the driverKey).
  router.get(
    "/api/storage/objects/:id/content",
    rateLimited(60),
    requireModulePermission("storage", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const row = await loadAccessibleObject(c.req.param("id"), orgId, c.get("user").id);

      const [disk] = await db
        .select()
        .from(storageDisks)
        .where(eq(storageDisks.id, row.diskId))
        .limit(1);
      if (!disk) throw notFound("Storage disk not found");

      const bytes = await resolveDriver(disk, makeDriverContext(actorOf(c))).read(
        row.driverKey,
        row.mime,
      );
      if (!bytes) throw notFound("Object content is no longer available");

      // Harden against stored XSS: the bytes + MIME are user-controlled
      // (uploaded files, remote disks) and served from the app origin under
      // the caller's session. Coerce script-capable types to a non-rendering
      // type, force `nosniff` (so a coerced type can't be sniffed back to
      // HTML) + `attachment` for those, and sandbox the response (defense in
      // depth for direct navigation; the UI previews via blob URLs, which keep
      // working because safe types pass through unchanged).
      const dangerous = SCRIPTABLE_MIME.test(bytes.mime);
      const safeMime = dangerous ? "application/octet-stream" : bytes.mime;
      return new Response(new Uint8Array(bytes.bytes), {
        headers: {
          "Content-Type": safeMime,
          "Content-Disposition": `${dangerous ? "attachment" : "inline"}; filename="${encodeURIComponent(row.name)}"`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      });
    },
  );

  // DELETE /api/storage/objects/:id — delete bytes + row (writable disks only)
  router.delete(
    "/api/storage/objects/:id",
    requireModulePermission("storage", "delete"),
    async (c) => {
      const orgId = c.get("orgId");
      const row = await loadAccessibleObject(c.req.param("id"), orgId, c.get("user").id);

      const [disk] = await db
        .select()
        .from(storageDisks)
        .where(eq(storageDisks.id, row.diskId))
        .limit(1);
      const driver = disk ? resolveDriver(disk) : null;
      if (!driver?.remove) {
        throw invalidRequest("objects on a read-only disk cannot be deleted");
      }
      await driver.remove(row.driverKey);
      await db.delete(storageObjects).where(eq(storageObjects.id, row.id));
      emitStorageObjectEvent({ type: "object.deleted", id: row.id, orgId });
      return c.body(null, 204);
    },
  );

  return router;
}
