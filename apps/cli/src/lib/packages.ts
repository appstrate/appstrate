// SPDX-License-Identifier: Apache-2.0

/**
 * The authoring loop's view of a package: where it lives and who may write it
 * (`GET …/home`), what its draft's optimistic lock is, and how a local working
 * folder compares to one of its definitions. Definitions themselves are read
 * through `./package-definition.ts`, the path `skills sync` reads them through.
 */

import { lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { AgentDetail, OrgPackageItemDetail, PackageHome } from "@appstrate/shared-types";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import {
  PACKAGE_FILE_INLINE_MAX_BYTES,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_TYPE_ROUTE_SEGMENT,
} from "@appstrate/core/package-files";
import { decodePackageFileText } from "@appstrate/core/package-file-operations";
import { packageTypeEnum, type PackageType } from "@appstrate/core/validation";
import { isSafeArchivePath } from "@appstrate/core/zip";
import { apiFetch, ApiError } from "./api.ts";
import { getDataDir } from "./config.ts";
import { withFileLock } from "./file-lock.ts";

export type PackageFiles = Record<string, Uint8Array>;

/** The skill entry, which alone makes a folder without a manifest a package folder. */
const SKILL_ENTRY = "SKILL.md";

/** The signature file of a published archive: produced by publishing, never authored. */
const SIGNATURE_RECORD = "RECORD";

/** Tooling residue by name, on top of every dot-named entry. */
const IGNORED_NAMES: ReadonlySet<string> = new Set(["node_modules", "__pycache__"]);

/** `/api/packages/<segment>/@scope/name`: the per-type detail, update and versions root. */
export function packageRoute(type: PackageType, packageId: string): string {
  return `/api/packages/${PACKAGE_TYPE_ROUTE_SEGMENT[type]}/${encodePackageIdPath(packageId)}`;
}

/** The RFC 9457 `code` and `detail` an {@link ApiError} carries, whichever are there. */
export function problemOf(err: ApiError): { code?: string; detail?: string } {
  const body = err.body as { code?: unknown; detail?: unknown } | undefined;
  if (!body || typeof body !== "object") return {};
  return {
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
  };
}

/** Where a package lives and how this caller reaches it; `null` when no readable package has this id. */
export async function resolvePackage(
  profileName: string,
  packageId: string,
): Promise<PackageHome | null> {
  if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${packageId}`);
  try {
    return await apiFetch<PackageHome>(
      profileName,
      `/api/packages/${encodePackageIdPath(packageId)}/home`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The space to read a package from: its home for a writer — the draft and the
 * versions answer there — else the pinned space when it reads the package,
 * else the first space that does. `undefined` leaves the pinned space in the
 * header. A `null` home is a withheld home or a system package, both readable.
 */
export function readSpaceOf(home: PackageHome, pinnedSpaceId?: string): string | undefined {
  if (home.home_writable && home.home_space_id) return home.home_space_id;
  if (pinnedSpaceId && home.read_space_ids.includes(pinnedSpaceId)) return pinnedSpaceId;
  return home.read_space_ids[0];
}

/** What the loop reads from a per-type detail or update response. */
export type DraftDetail = Pick<
  OrgPackageItemDetail | AgentDetail,
  "lock_version" | "manifest" | "has_unarchived_changes"
>;

export interface DraftState {
  lockVersion: number;
  manifest: Record<string, unknown>;
  /**
   * The server's `has_unarchived_changes`: whether the draft moved since the
   * latest version was cut. The dashboard's publish button reads the same flag.
   */
  hasUnpublishedChanges: boolean;
}

/** The draft's lock and validated manifest, read in the home space. Writers only. */
export async function readDraftState(profileName: string, home: PackageHome): Promise<DraftState> {
  const detail = await apiFetch<DraftDetail>(
    profileName,
    `${packageRoute(home.type, home.id)}?version=draft`,
    home.home_space_id ? { spaceId: home.home_space_id } : {},
  );
  return draftStateOf(home.id, detail);
}

/** A detail or update response, narrowed to what the loop needs from it. */
export function draftStateOf(packageId: string, detail: DraftDetail): DraftState {
  if (typeof detail.lock_version !== "number" || !detail.manifest) {
    throw new Error(`${packageId}: the draft detail carries no lock_version or manifest.`);
  }
  return {
    lockVersion: detail.lock_version,
    manifest: detail.manifest,
    hasUnpublishedChanges: detail.has_unarchived_changes !== false,
  };
}

// ─── working folder ──────────────────────────────────────────────────────

/**
 * Whether the loop leaves a path alone on BOTH sides: never read, never pushed,
 * never deleted from the draft, never reported. Any dot-named segment (`.git`,
 * `.env`, `.DS_Store`, editor state), `node_modules`, `__pycache__`, and the
 * root `RECORD` a published archive is signed with.
 */
export function isIgnoredPath(path: string): boolean {
  if (path === SIGNATURE_RECORD) return true;
  return path.split("/").some((segment) => segment.startsWith(".") || IGNORED_NAMES.has(segment));
}

/**
 * Every non-ignored file under `dir` → its path on disk, keyed by its NFC,
 * `/`-joined path, as the archive would name it. A symlink is refused, naming
 * it: what it points at is not the folder's to send, and silently skipping it
 * would push a package missing a file its author sees.
 */
export async function listFolderFiles(dir: string): Promise<Map<string, string>> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dir);
  } catch {
    throw new Error(`${dir}: no such directory.`);
  }
  if (!info.isDirectory()) throw new Error(`${dir}: not a directory.`);

  const found = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = entry.name.normalize("NFC");
      const path = prefix ? `${prefix}/${name}` : name;
      if (isIgnoredPath(path)) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${path}: a symbolic link. Replace it with the file itself.`);
      }
      if (entry.isDirectory()) {
        await walk(full, path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`${path}: not a regular file.`);
      if (found.has(path)) {
        throw new Error(`${path}: two files in this folder have this name once normalized.`);
      }
      found.set(path, full);
    }
  };
  await walk(dir, "");
  return found;
}

/**
 * {@link listFolderFiles}, read — after refusing, naming the file and before
 * any byte leaves the machine, what the draft write would refuse anyway: a
 * path no package can carry, a file over the per-file ceiling.
 */
export async function readPackageFolder(dir: string): Promise<PackageFiles> {
  const found = await listFolderFiles(dir);
  for (const [path, full] of found) {
    if (!isSafeArchivePath(path)) {
      throw new Error(
        `${path}: not a path a package can carry (no commas, line breaks or backslashes).`,
      );
    }
    const { size } = await lstat(full);
    if (size > PACKAGE_FILE_INLINE_MAX_BYTES) {
      throw new Error(`${path}: ${size} bytes, over the 1 MiB limit of a package file.`);
    }
  }
  const files: PackageFiles = {};
  for (const [path, full] of found) files[path] = new Uint8Array(await readFile(full));
  if (!files[PACKAGE_MANIFEST_FILE] && !files[SKILL_ENTRY]) {
    throw new Error(
      `${dir}: neither ${PACKAGE_MANIFEST_FILE} nor ${SKILL_ENTRY} at the top level. A package folder starts with one of them.`,
    );
  }
  return files;
}

/** The folder's `manifest.json`, parsed; `undefined` when it has none. */
export function folderManifest(files: PackageFiles): Record<string, unknown> | undefined {
  const raw = files[PACKAGE_MANIFEST_FILE];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error(`${PACKAGE_MANIFEST_FILE} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PACKAGE_MANIFEST_FILE} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** The manifest's `type`, else a skill when the folder has a `SKILL.md`. */
export function typeOfFolder(files: PackageFiles): PackageType | null {
  const declared = packageTypeEnum.safeParse(folderManifest(files)?.type);
  if (declared.success) return declared.data;
  return files[SKILL_ENTRY] ? "skill" : null;
}

// ─── comparison ──────────────────────────────────────────────────────────

type ChangeKind = "modified" | "added" | "removed";

export interface FileChange {
  path: string;
  kind: ChangeKind;
}

/** Code-unit order: the same on every machine and locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * File-by-file comparison of a folder to a definition. Ignored paths are out of
 * it on both sides, so a dotfile in the draft is neither deleted nor reported.
 * `manifest.json` counts — an agent's, an integration's or an MCP server's
 * configuration lives there — compared as JSON, so formatting alone is not a
 * change; a folder without one does not author its manifest, and the draft's
 * is then not compared at all.
 */
export function diffFiles(local: PackageFiles, remote: PackageFiles): FileChange[] {
  const authorsManifest = PACKAGE_MANIFEST_FILE in local;
  const tracked = (path: string) =>
    !isIgnoredPath(path) && (authorsManifest || path !== PACKAGE_MANIFEST_FILE);
  const changes: FileChange[] = [];
  for (const path of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (!tracked(path)) continue;
    const mine = local[path];
    const theirs = remote[path];
    if (mine && !theirs) changes.push({ path, kind: "added" });
    else if (!mine && theirs) changes.push({ path, kind: "removed" });
    else if (mine && theirs && !sameContent(path, mine, theirs)) {
      changes.push({ path, kind: "modified" });
    }
  }
  return changes.sort((a, b) => byCodeUnit(a.path, b.path));
}

function sameContent(path: string, a: Uint8Array, b: Uint8Array): boolean {
  if (path === PACKAGE_MANIFEST_FILE) {
    const left = parseJson(a);
    const right = parseJson(b);
    if (left !== undefined && right !== undefined) {
      return canonicalJson(left) === canonicalJson(right);
    }
  }
  return Buffer.from(a).equals(Buffer.from(b));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** JSON with object keys sorted by code unit, so two equal manifests serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => byCodeUnit(a, b)),
        )
      : v,
  );
}

/** The manifest as a folder stores it: what `pull` writes and `push` rewrites. */
export function manifestFileText(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** One entry of the draft `PUT`'s `operations`. */
type FileOperation =
  | { op: "write"; path: string; text: string }
  | { op: "write"; path: string; bytes_base64: string }
  | { op: "delete"; path: string };

/** `text` when the bytes ARE text by the platform's own rule, else base64, so a binary annex arrives byte for byte. */
export function writeOperation(path: string, bytes: Uint8Array): FileOperation {
  const text = decodePackageFileText(bytes);
  return text !== null
    ? { op: "write", path, text }
    : { op: "write", path, bytes_base64: Buffer.from(bytes).toString("base64") };
}

/** The operations that turn the draft into the folder. `manifest.json` travels as `manifest`, never as a file. */
export function toOperations(changes: FileChange[], local: PackageFiles): FileOperation[] {
  return changes
    .filter((change) => change.path !== PACKAGE_MANIFEST_FILE)
    .map((change) =>
      change.kind === "removed"
        ? { op: "delete" as const, path: change.path }
        : writeOperation(change.path, local[change.path]!),
    );
}

// ─── draft locks per working folder ──────────────────────────────────────

/**
 * `<data dir>/packages/<profile>-locks.json`: working folder (its real path) →
 * the package it holds and the draft lock that folder last read from a pull or
 * wrote with a push. Keyed by FOLDER, not by package: two folders of one
 * package are two authors, and the second push must not ride the lock the
 * first one moved. Only a DRAFT read records a lock: a published version says
 * nothing about the draft. Every write is a read-modify-write under an flock
 * on the `.lock` beside it, so two commands never drop each other's entries.
 */
function locksPath(profileName: string): string {
  return join(getDataDir(), "packages", `${profileName}-locks.json`);
}

function locksMutexPath(profileName: string): string {
  return join(getDataDir(), "packages", `${profileName}-locks.lock`);
}

type LockEntry = { packageId: string; lock: number };
type LockTable = Record<string, LockEntry>;

/** The key a folder is recorded under: its real path, so a symlinked or relative spelling finds it. */
async function folderKey(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

async function readLockTable(profileName: string): Promise<LockTable> {
  let raw: string;
  try {
    raw = await readFile(locksPath(profileName), "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const table: LockTable = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = value as Partial<LockEntry> | null;
    if (entry && typeof entry.packageId === "string" && typeof entry.lock === "number") {
      table[key] = { packageId: entry.packageId, lock: entry.lock };
    }
  }
  return table;
}

async function updateLockTable(
  profileName: string,
  mutate: (table: LockTable) => void,
): Promise<void> {
  await withFileLock(
    locksMutexPath(profileName),
    "packages lock update",
    async () => {
      const table = await readLockTable(profileName);
      mutate(table);
      const path = locksPath(profileName);
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
    },
    { timeoutMs: 10_000, pollMs: 25 },
  );
}

/** The lock `dir` last saw of `packageId`'s draft, or `undefined` when it never read that draft. */
export async function readLock(
  profileName: string,
  dir: string,
  packageId: string,
): Promise<number | undefined> {
  const entry = (await readLockTable(profileName))[await folderKey(dir)];
  return entry?.packageId === packageId ? entry.lock : undefined;
}

export async function recordLock(
  profileName: string,
  dir: string,
  packageId: string,
  lock: number,
): Promise<void> {
  const key = await folderKey(dir);
  await updateLockTable(profileName, (table) => {
    table[key] = { packageId, lock };
  });
}

/** `dir` no longer holds what the draft was at any lock: its next push needs `--force`. */
export async function forgetLock(profileName: string, dir: string): Promise<void> {
  const key = await folderKey(dir);
  await updateLockTable(profileName, (table) => {
    delete table[key];
  });
}

/**
 * Move every folder of `packageId` that saw the draft at `from` to `to`, and
 * return those folders. For a draft change the platform made itself (a publish
 * rewriting the manifest's version) that every folder current with it has
 * therefore seen.
 */
export async function advanceLocks(
  profileName: string,
  packageId: string,
  from: number,
  to: number,
): Promise<string[]> {
  const moved: string[] = [];
  await updateLockTable(profileName, (table) => {
    for (const [dir, entry] of Object.entries(table)) {
      if (entry.packageId !== packageId || entry.lock !== from) continue;
      table[dir] = { packageId, lock: to };
      moved.push(dir);
    }
  });
  return moved.sort(byCodeUnit);
}
