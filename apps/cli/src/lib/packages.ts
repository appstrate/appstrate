// SPDX-License-Identifier: Apache-2.0

/**
 * The authoring loop's view of a package: where it lives, who may write it, and
 * how a local working folder compares to it. Every call rides routes the
 * platform already serves — the per-type detail (home, write right, lock), the
 * type-agnostic file index and file bytes, and the per-type `PUT` whose file
 * operations write a draft under its optimistic lock. Nothing here needs a
 * server change.
 */

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { apiFetch, apiFetchRaw, ApiError } from "./api.ts";
import { getDataDir, getProfile } from "./config.ts";
import { listSpaces } from "./spaces.ts";

export type PackageType = "skill" | "agent" | "integration" | "mcp-server";

export const PACKAGE_TYPES: readonly PackageType[] = [
  "skill",
  "agent",
  "integration",
  "mcp-server",
];

const TYPE_PLURAL: Record<PackageType, string> = {
  skill: "skills",
  agent: "agents",
  integration: "integrations",
  "mcp-server": "mcp-servers",
};

/** The file a package of that type is authored around, when it has one. */
export const CONTENT_ENTRY: Record<PackageType, string | null> = {
  skill: "SKILL.md",
  agent: "prompt.md",
  integration: null,
  "mcp-server": null,
};

export const MANIFEST = "manifest.json";

/** Never read from a working folder: tooling residue, not package content. */
const SKIPPED_ENTRIES = new Set([".git", ".DS_Store", "node_modules", ".venv", "__pycache__"]);

/** The `PUT` accepts at most this many operations per request. */
export const MAX_OPERATIONS_PER_PUT = 200;

function isPackageType(value: unknown): value is PackageType {
  return typeof value === "string" && (PACKAGE_TYPES as readonly string[]).includes(value);
}

/** `/api/packages/<plural>/@scope/name`: the per-type detail, update and versions root. */
export function packagePath(type: PackageType, packageId: string): string {
  return `/api/packages/${TYPE_PLURAL[type]}/${encodePackageIdPath(packageId)}`;
}

/** `/api/packages/<plural>`: the per-type create route. */
export function packageCollectionPath(type: PackageType): string {
  return `/api/packages/${TYPE_PLURAL[type]}`;
}

export interface LocatedPackage {
  packageId: string;
  type: PackageType;
  /** The space whose `<type>:write` governs the draft, the versions and the identity. */
  homeSpaceId: string;
  /** Whether this caller may write the draft and publish. */
  homeWritable: boolean;
  /** The draft's optimistic-lock token, when the caller may see it. */
  lockVersion: number | undefined;
  manifest: Record<string, unknown> | undefined;
}

interface DetailBody {
  home_space_id?: unknown;
  home_writable?: unknown;
  lock_version?: unknown;
  manifest?: unknown;
}

/**
 * Find a package. The per-type detail is space-scoped: it answers for a package
 * placed in, or homed in, the space the request names, and 404 otherwise — also
 * for a type the id is not, and for an id the caller cannot read at all. So the
 * pinned space is asked first, then every other space this profile is a member
 * of: a package homed in a personal space is invisible from the team space it
 * was never placed in. `type`, when the caller knows it, spares the probes of
 * the other three types. `null` means no readable package has this id.
 */
export async function locatePackage(
  profileName: string,
  packageId: string,
  type?: PackageType,
): Promise<LocatedPackage | null> {
  if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${packageId}`);
  const types = type ? [type] : PACKAGE_TYPES;
  const probe = async (spaceId: string | undefined): Promise<LocatedPackage | null> => {
    for (const candidate of types) {
      try {
        const detail = await apiFetch<DetailBody>(
          profileName,
          packagePath(candidate, packageId),
          spaceId ? { spaceId } : {},
        );
        return toLocated(packageId, candidate, detail);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) continue;
        throw err;
      }
    }
    return null;
  };
  const inPinned = await probe(undefined);
  if (inPinned) return inPinned;
  const pinned = (await getProfile(profileName))?.spaceId;
  for (const space of await listSpaces(profileName)) {
    if (space.access !== "member" || space.id === pinned) continue;
    const found = await probe(space.id);
    if (found) return found;
  }
  return null;
}

export function toLocated(
  packageId: string,
  type: PackageType,
  detail: DetailBody,
): LocatedPackage {
  if (typeof detail.home_space_id !== "string") {
    throw new Error(
      `${packageId} has no home space in its detail: the instance is too old for this command.`,
    );
  }
  return {
    packageId,
    type,
    homeSpaceId: detail.home_space_id,
    homeWritable: detail.home_writable === true,
    lockVersion: typeof detail.lock_version === "number" ? detail.lock_version : undefined,
    manifest:
      typeof detail.manifest === "object" &&
      detail.manifest !== null &&
      !Array.isArray(detail.manifest)
        ? (detail.manifest as Record<string, unknown>)
        : undefined,
  };
}

interface FileIndexEntry {
  path?: unknown;
  inline?: unknown;
}

/**
 * Every file of one definition of a package: `draft`, or a published version
 * spec (`latest`, an exact version, a range). Small text files come inline with
 * the index; the others are fetched one by one as raw bytes, so a binary annex
 * travels untouched.
 */
export async function fetchPackageFiles(
  profileName: string,
  located: LocatedPackage,
  selector: string,
): Promise<Record<string, Uint8Array>> {
  const base = `/api/packages/${encodePackageIdPath(located.packageId)}/files`;
  const query = `version=${encodeURIComponent(selector)}`;
  const spaceId = located.homeSpaceId;
  const index = await apiFetch<{ entries?: unknown }>(profileName, `${base}?${query}`, { spaceId });
  if (!Array.isArray(index.entries)) {
    throw new Error(`Malformed file index for ${located.packageId}: expected { entries: [...] }.`);
  }
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const entry of index.entries as FileIndexEntry[]) {
    if (typeof entry.path !== "string") continue;
    if (typeof entry.inline === "string") {
      files[entry.path] = encoder.encode(entry.inline);
      continue;
    }
    const res = await apiFetchRaw(
      profileName,
      `${base}/content?path=${encodeURIComponent(entry.path)}&${query}`,
      { spaceId },
    );
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `Could not read ${entry.path} of ${located.packageId}: HTTP ${res.status}`,
      );
    }
    files[entry.path] = new Uint8Array(await res.arrayBuffer());
  }
  return files;
}

/** Every file under `dir`, keyed by its forward-slash path. */
export async function readPackageFolder(dir: string): Promise<Record<string, Uint8Array>> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dir);
  } catch {
    throw new Error(`${dir}: no such directory.`);
  }
  if (!info.isDirectory()) throw new Error(`${dir}: not a directory.`);

  const files: Record<string, Uint8Array> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (SKIPPED_ENTRIES.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files[relative(dir, full).split("\\").join("/")] = new Uint8Array(await readFile(full));
      }
    }
  };
  await walk(dir);
  if (!files[MANIFEST] && !files["SKILL.md"]) {
    throw new Error(
      `${dir}: neither ${MANIFEST} nor SKILL.md at the top level. A package folder starts with one of them.`,
    );
  }
  return files;
}

/** Type from a folder's files: the manifest's `type`, else a skill when it has a SKILL.md. */
export function typeOfFolder(files: Record<string, Uint8Array>): PackageType | null {
  const manifest = files[MANIFEST];
  if (manifest) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(manifest)) as { type?: unknown };
      if (isPackageType(parsed.type)) return parsed.type;
    } catch {
      // Reported where the manifest is actually parsed.
    }
  }
  return files["SKILL.md"] ? "skill" : null;
}

export type ChangeKind = "modified" | "added" | "removed";

export interface FileChange {
  path: string;
  kind: ChangeKind;
}

/**
 * File-by-file comparison of a folder to a definition, `manifest.json`
 * included: an agent's, an integration's or an MCP server's configuration lives
 * there, so a manifest-only edit is a change like any other. Manifests are
 * compared as JSON, not as bytes, so indentation alone is not a change.
 */
export function diffFiles(
  local: Record<string, Uint8Array>,
  remote: Record<string, Uint8Array>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const mine = local[path];
    const theirs = remote[path];
    if (mine && !theirs) changes.push({ path, kind: "added" });
    else if (!mine && theirs) changes.push({ path, kind: "removed" });
    else if (mine && theirs && !sameContent(path, mine, theirs)) {
      changes.push({ path, kind: "modified" });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function sameContent(path: string, a: Uint8Array, b: Uint8Array): boolean {
  if (path === MANIFEST) {
    const left = parseJson(a);
    const right = parseJson(b);
    if (left !== undefined && right !== undefined)
      return canonicalJson(left) === canonicalJson(right);
  }
  return sameBytes(a, b);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** JSON with object keys sorted, so two equal manifests serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export type FileOperation =
  | { op: "write"; path: string; text: string }
  | { op: "write"; path: string; bytes_base64: string }
  | { op: "delete"; path: string };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A write carries `text` only when the bytes ARE that text: strict UTF-8 that
 * re-encodes to the same bytes. Anything else travels as base64, so a binary
 * annex (an image, a font, a compiled helper) reaches the draft byte for byte.
 */
export function writeOperation(path: string, bytes: Uint8Array): FileOperation {
  try {
    const text = strictUtf8.decode(bytes);
    if (sameBytes(new TextEncoder().encode(text), bytes)) return { op: "write", path, text };
  } catch {
    // Not UTF-8: base64 below.
  }
  return { op: "write", path, bytes_base64: Buffer.from(bytes).toString("base64") };
}

/** The operations that turn the draft into the folder. `manifest.json` travels as `manifest`, never as a file. */
export function toOperations(
  changes: FileChange[],
  local: Record<string, Uint8Array>,
): FileOperation[] {
  return changes
    .filter((change) => change.path !== MANIFEST)
    .map((change) =>
      change.kind === "removed"
        ? { op: "delete" as const, path: change.path }
        : writeOperation(change.path, local[change.path]!),
    );
}

/** `[a, b, c, d, e]` in batches of `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `<data dir>/packages/<profile>-locks.json`: working folder (absolute path) →
 * the package it holds and the draft lock that folder last read from a pull or
 * wrote with a push. Keyed by FOLDER, not by package: two folders of one
 * package on one machine are two authors, and the second push must not ride
 * the lock the first one moved. Only a DRAFT read records a lock: a published
 * version says nothing about the draft, and a lock taken from it would let the
 * next push overwrite edits it never saw.
 */
function locksPath(profileName: string): string {
  return join(getDataDir(), "packages", `${profileName}-locks.json`);
}

type LockEntry = { packageId: string; lock: number };

async function readLockFile(profileName: string): Promise<Record<string, LockEntry>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(locksPath(profileName), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, LockEntry] => {
          const value = entry[1] as Partial<LockEntry> | null;
          return (
            typeof value === "object" &&
            value !== null &&
            typeof value.packageId === "string" &&
            typeof value.lock === "number"
          );
        },
      ),
    );
  } catch {
    return {};
  }
}

/** The lock `dir` last saw of `packageId`'s draft, or `undefined` when it never read that draft. */
export async function readLock(
  profileName: string,
  dir: string,
  packageId: string,
): Promise<number | undefined> {
  const entry = (await readLockFile(profileName))[dir];
  return entry?.packageId === packageId ? entry.lock : undefined;
}

export async function recordLock(
  profileName: string,
  dir: string,
  packageId: string,
  lock: number,
): Promise<void> {
  const locks = await readLockFile(profileName);
  locks[dir] = { packageId, lock };
  const path = locksPath(profileName);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(locks, null, 2)}\n`, { mode: 0o600 });
}

/** `version:` pinned in a SKILL.md frontmatter, when the author pins it there. */
export function frontmatterVersion(skillMd: string): string | undefined {
  const block = skillMd.match(/^---[^\S\n]*\n([\s\S]*?)\n---/)?.[1];
  const line = block?.match(/^version:[ \t]*["']?([0-9]+\.[0-9]+\.[0-9]+[^"'\s]*)["']?[ \t]*$/m);
  return line?.[1];
}

export function bumpPatch(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "1.0.0";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** The latest published version, or `null` when nothing was ever published. */
export async function latestPublished(
  profileName: string,
  type: PackageType,
  packageId: string,
  spaceId?: string,
): Promise<string | null> {
  try {
    const latest = await apiFetch<{ version?: unknown }>(
      profileName,
      `${packagePath(type, packageId)}/versions/latest`,
      spaceId ? { spaceId } : {},
    );
    return typeof latest.version === "string" ? latest.version : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
