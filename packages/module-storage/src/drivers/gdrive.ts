// SPDX-License-Identifier: Apache-2.0

/**
 * Google Drive cloud driver — READ-ONLY browse/read of chosen folders, through
 * the platform's **native integration connection**.
 *
 * No OAuth here: the disk references one of the user's existing integration
 * connections (`{ integration_id, connection_id, application_id, folder_ids }`)
 * and every Drive call goes through the core **credential-proxy**
 * (`ctx.proxyCall`), which injects that connection's credentials server-side
 * and refreshes them as needed. The driver never sees a raw token. The Drive
 * scope (e.g. `drive.readonly`) is whatever the connection was granted — it's
 * managed in the integration, not here.
 *
 * `folder_ids` scoping is mandatory (never the whole Drive). Listing walks the
 * folders breadth-first; Google-native docs export as PDF on read, the rest
 * download with `alt=media`.
 */

import type { StorageDriver, DriverObject, ObjectBytes, DriverContext } from "./types.ts";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Google-native types that have no raw bytes — exported as PDF on read. */
const EXPORTABLE_MIMES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
]);

interface DriveConfig {
  /** Integration package id of the picked connection, e.g. `@appstrate/google-drive`. */
  integration_id: string;
  /** The picked integration connection id. */
  connection_id: string;
  /** Application the connection lives in (proxy credential scope). */
  application_id: string;
  folder_ids: string[];
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

export function createGdriveDriver(
  rawConfig: Record<string, unknown>,
  ctx: DriverContext,
): StorageDriver {
  const config = rawConfig as unknown as DriveConfig;

  /** One Drive API GET through the credential-proxy (creds injected server-side). */
  async function driveGet(target: string): Promise<Response> {
    const res = await ctx.proxyCall({
      applicationId: config.application_id,
      actor: ctx.actor,
      integrationId: config.integration_id,
      connectionId: config.connection_id,
      method: "GET",
      target,
    });
    // Re-wrap as a standard Response so callers use json()/arrayBuffer().
    const response = new Response(res.body, { status: res.status });
    if (!response.ok) {
      throw new Error(`Drive API ${res.status} via credential-proxy`);
    }
    return response;
  }

  return {
    async *list(since): AsyncGenerator<DriverObject> {
      // BFS over the shared folders — `folder_ids` scoping is mandatory.
      const queue = [...config.folder_ids];
      const seenFolders = new Set<string>(queue);
      while (queue.length > 0) {
        const folderId = queue.shift()!;
        let pageToken: string | undefined;
        do {
          const q = [
            `'${folderId.replaceAll("'", "\\'")}' in parents`,
            "trashed = false",
            ...(since ? [`modifiedTime > '${since.toISOString()}'`] : []),
          ].join(" and ");
          const params = new URLSearchParams({
            q,
            fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
            pageSize: "200",
            ...(pageToken ? { pageToken } : {}),
          });
          const page = (await (await driveGet(`${DRIVE_API}/files?${params}`)).json()) as {
            nextPageToken?: string;
            files?: DriveFile[];
          };

          for (const file of page.files ?? []) {
            if (file.mimeType === FOLDER_MIME) {
              if (!seenFolders.has(file.id)) {
                seenFolders.add(file.id);
                queue.push(file.id);
              }
              continue;
            }
            yield {
              driverKey: file.id,
              name: file.name,
              mime: file.mimeType,
              sizeBytes: file.size ? Number(file.size) : null,
              modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
            };
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
    },

    async read(driverKey, mime): Promise<ObjectBytes | null> {
      const id = encodeURIComponent(driverKey);
      const exportable = EXPORTABLE_MIMES.has(mime ?? "");
      const url = exportable
        ? `${DRIVE_API}/files/${id}/export?mimeType=application%2Fpdf`
        : `${DRIVE_API}/files/${id}?alt=media`;
      const res = await driveGet(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const resolvedMime = exportable
        ? "application/pdf"
        : (res.headers.get("content-type") ?? mime ?? "application/octet-stream");
      return { bytes, mime: resolvedMime };
    },

    // No write/remove: Drive disks are read-only in v1.
  };
}
