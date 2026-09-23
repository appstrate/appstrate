// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate packages pull | status | push | publish` — the authoring loop: a
 * package (skill, agent, integration, MCP server) is edited in a local working
 * folder and written back to its DRAFT, then published as a deliberate step.
 *
 *   pull     the draft (or a published version) → a working folder
 *   status   what the folder would change in the draft, computed on demand
 *   push     the folder → the draft, in one atomic write, under the ETag this
 *            folder last saw
 *   publish  the draft → a version, by the dashboard's version rule
 *
 * Authority is the package's HOME space: only a caller who may write there
 * reads the draft, pushes or publishes; everyone else reads the published
 * version, read-only. Sharing and activation stay out of this loop.
 */

import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PackageHome, PackageVersionInfoResponse } from "@appstrate/shared-types";
import { parseScopedName } from "@appstrate/core/naming";
import {
  PACKAGE_CONTENT_ENTRY,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_TYPE_ROUTE_SEGMENT,
} from "@appstrate/core/package-files";
import {
  canonicalPackagePath,
  decodePackageFileText,
} from "@appstrate/core/package-file-operations";
import { planPublishVersion, type VersionBump } from "@appstrate/core/semver";
import { extractSkillMeta, packageTypeEnum, type PackageType } from "@appstrate/core/validation";
import { isSafeArchivePath, zipArtifact } from "@appstrate/core/zip";
import { apiFetch, apiFetchWithHeaders, ApiError, problemFields } from "../lib/api.ts";
import {
  expandHome,
  packageWorkDir,
  readConfig,
  resolveActiveProfile,
  resolveWorkDir,
  type Profile,
} from "../lib/config.ts";
import { PROJECT_FILE_RELPATH } from "../lib/install/project.ts";
import { listOrgs } from "../lib/orgs.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { DRAFT_SELECTOR, splitPackageSpec } from "../lib/package-spec.ts";
import { ExplainedError, formatError } from "../lib/ui.ts";
import {
  draftRefusal,
  fetchPackageDefinition,
  PackageDefinitionError,
  SIGNATURE_RECORD,
} from "../lib/package-definition.ts";
import {
  advanceLocks,
  byCodeUnit,
  diffFiles,
  draftStateOf,
  folderManifest,
  forgetLock,
  isIgnoredPath,
  listFolderFiles,
  manifestFileText,
  packageRoute,
  readDraftState,
  readLock,
  readPackageFolder,
  readSpaceOf,
  recordLock,
  resolvePackage,
  toOperations,
  typeOfFolder,
  type DraftDetail,
  type FileChange,
  type PackageFiles,
} from "../lib/packages.ts";
import { SKILL_ENTRY } from "../lib/skills-sync/materialize.ts";

interface Session {
  profileName: string;
  profile: Profile;
  slug?: string;
}

/** The active profile with an organization pinned, or a written reason and exit 1. */
async function openSession(explicit: string | undefined, io: CommandIO): Promise<Session | null> {
  const { profileName, profile } = await resolveActiveProfile(explicit);
  if (!profile) {
    io.stderr.write(
      `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    io.exit(1);
    return null;
  }
  if (!profile.orgId) {
    io.stderr.write("No organization pinned. Run: appstrate org switch\n");
    io.exit(1);
    return null;
  }
  return { profileName, profile };
}

async function orgSlug(session: Session): Promise<string> {
  if (session.slug) return session.slug;
  const org = (await listOrgs(session.profileName)).find((o) => o.id === session.profile.orgId);
  if (!org) {
    throw new Error(
      `Organization ${session.profile.orgId} is not one this profile belongs to. Run: appstrate org switch`,
    );
  }
  session.slug = org.slug;
  return org.slug;
}

/** `@scope/name` as given, a bare name under the organization's slug. */
async function resolvePackageId(session: Session, ref: string): Promise<string> {
  const packageId = ref.startsWith("@") ? ref : `@${await orgSlug(session)}/${ref}`;
  if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${ref}`);
  return packageId;
}

/** Refuse the command with a message that names the package, never a bare status. */
function describeProblem(err: ApiError): string {
  const { code, detail } = problemFields(err.body);
  return `${detail ?? err.message}${code ? ` (${code})` : ""}`;
}

// ─── folders ─────────────────────────────────────────────────────────────

const PACKAGE_TYPES: readonly PackageType[] = packageTypeEnum.options;

/** `~/Appstrate` is an instance directory that `uninstall --purge` removes: never a work dir. */
async function assertNotInstallDir(workDir: string): Promise<void> {
  const marker = join(workDir, PROJECT_FILE_RELPATH);
  try {
    await stat(marker);
  } catch (err) {
    if (isAbsent(err)) return;
    throw new Error(`${marker}: cannot be read.`, { cause: err });
  }
  throw new Error(
    `${workDir} is an Appstrate instance directory (it has ${PROJECT_FILE_RELPATH}); \`appstrate uninstall --purge\` would delete your working copies. Set workDir in config.toml to another folder.`,
  );
}

/** ENOENT, or ENOTDIR — a parent that is a file: the path does not exist. Anything else is a real failure. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (isAbsent(err)) return false;
    throw new Error(`${path}: cannot be read.`, { cause: err });
  }
}

/** A path as a shell user means it: a separator, a leading `.` or `~`. `@scope/name` is an id. */
function isPathLike(target: string): boolean {
  return (
    !target.startsWith("@") &&
    (target.includes("/") || target.startsWith(".") || target.startsWith("~"))
  );
}

/** A folder, and the package id it must hold when it was found by that id. */
interface ResolvedFolder {
  dir: string;
  expectedId?: string;
}

/**
 * The package's working copy in the work dir, the folder `packages pull` fills
 * by default. A bare name is `@<org slug>/<name>`; a scoped ref keeps its scope.
 */
async function findWorkingCopy(session: Session, ref: string): Promise<ResolvedFolder | null> {
  const packageId = await resolvePackageId(session, ref);
  const config = await readConfig();
  await assertNotInstallDir(resolveWorkDir(config));
  const slug = await orgSlug(session);
  for (const type of PACKAGE_TYPES) {
    const dir = packageWorkDir(config, slug, type, packageId);
    if (await isDirectory(dir)) return { dir, expectedId: packageId };
  }
  return null;
}

/** A folder path as given (`~` expanded), else a bare name or id resolved in the work dir. */
async function resolveFolder(session: Session, target: string): Promise<ResolvedFolder> {
  if (isPathLike(target)) return { dir: resolve(expandHome(target)) };
  if (!target.startsWith("@") && (await isDirectory(resolve(target)))) {
    return { dir: resolve(target) };
  }
  const found = await findWorkingCopy(session, target);
  if (found) return found;
  throw new Error(
    `No working copy for ${target} in ${resolveWorkDir(await readConfig())}. Run: appstrate packages pull ${target}, or pass a folder path.`,
  );
}

/** A folder found in the work dir by id must hold that id: anything else is a stale or moved copy. */
function assertHolds(folder: ResolvedFolder, packageId: string): void {
  if (folder.expectedId !== undefined && folder.expectedId !== packageId) {
    throw new Error(
      `${folder.dir} holds ${packageId}, not ${folder.expectedId}. Pass the folder path, or pull ${folder.expectedId} again.`,
    );
  }
}

/** The folder's id: its manifest's `name`, else `@<org slug>/<SKILL.md frontmatter name>`. */
async function packageIdOfFolder(session: Session, files: PackageFiles): Promise<string> {
  const manifest = folderManifest(files);
  if (manifest) {
    if (typeof manifest.name !== "string" || !parseScopedName(manifest.name)) {
      throw new Error(`${PACKAGE_MANIFEST_FILE}: \`name\` must be @scope/name.`);
    }
    return manifest.name;
  }
  const meta = extractSkillMeta(new TextDecoder().decode(files[SKILL_ENTRY]!));
  if (!meta.name) throw new Error(`${SKILL_ENTRY}: frontmatter has no \`name\`.`);
  return `@${await orgSlug(session)}/${meta.name}`;
}

interface LocalPackage {
  dir: string;
  files: PackageFiles;
  type: PackageType;
  packageId: string;
}

async function readLocalPackage(session: Session, target: string): Promise<LocalPackage> {
  const folder = await resolveFolder(session, target);
  return readFolderPackage(session, folder);
}

async function readFolderPackage(session: Session, folder: ResolvedFolder): Promise<LocalPackage> {
  const { dir } = folder;
  const files = await readPackageFolder(dir);
  const type = typeOfFolder(files);
  if (!type) {
    throw new Error(
      `${dir}: no ${PACKAGE_MANIFEST_FILE} with a known \`type\`, and no ${SKILL_ENTRY}.`,
    );
  }
  const packageId = await packageIdOfFolder(session, files);
  assertHolds(folder, packageId);
  return { dir, files, type, packageId };
}

function assertSameType(local: LocalPackage, home: PackageHome): void {
  if (home.type !== local.type) {
    throw new Error(
      `${local.packageId} is a ${home.type} on Appstrate, but this folder is a ${local.type}.`,
    );
  }
}

async function rewriteManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, PACKAGE_MANIFEST_FILE), manifestFileText(manifest));
}

/** What to run instead when a draft is refused: its published version. */
function draftRemedyPull(packageId: string): string {
  return `Pull its published version instead: appstrate packages pull ${packageId}@latest.`;
}

// ─── pull ────────────────────────────────────────────────────────────────

export interface PackagesPullOptions {
  profile?: string;
  /**
   * `@scope/name`, or a bare name under the organization's slug, optionally
   * followed by `@<spec>`: a published version (`latest`, exact, range, tag),
   * or `draft`.
   */
  package: string;
  /** Destination folder. Default: `<workDir>/<org slug>/packages/<type segment>/@<scope>/<name>`. */
  dir?: string;
  /** Pull into a folder that already has files, making it mirror the definition. */
  force?: boolean;
}

export async function packagesPullCommand(
  opts: PackagesPullOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    const { ref, spec } = splitPackageSpec(opts.package);
    const packageId = await resolvePackageId(session, ref);
    const home = await resolvePackage(session.profileName, packageId);
    if (!home) throw new Error(`${packageId}: no package with this id that you can read.`);
    if (spec === DRAFT_SELECTOR && !home.home_writable) {
      throw draftRefusal(packageId, home.type, draftRemedyPull(packageId));
    }

    let dir: string;
    if (opts.dir) dir = resolve(expandHome(opts.dir));
    else {
      const config = await readConfig();
      await assertNotInstallDir(resolveWorkDir(config));
      dir = packageWorkDir(config, await orgSlug(session), home.type, packageId);
    }
    const existing = await prepareDestination(dir, opts.force === true);

    // The draft is the author's: read it when this caller may write the
    // package and named no version, or named the draft. Everyone else reads
    // what is published.
    const readsDraft = home.home_writable && (spec === undefined || spec === DRAFT_SELECTOR);
    let files: PackageFiles;
    let lock: string | undefined;
    if (readsDraft) {
      // Read BEFORE the archive: a version older than the bytes costs a spurious
      // 412 on the next push, a newer one would hide an edit.
      lock = (await readDraftState(session.profileName, home)).etag;
      files = await fetchPackageDefinition(session.profileName, {
        packageId,
        type: home.type,
        spaceId: home.home_space_id ?? undefined,
        source: "draft",
        refusalRemedy: draftRemedyPull(packageId),
      });
    } else {
      const published = await fetchPublished(session, home, spec ?? "latest");
      if (!published) {
        throw new Error(
          home.home_writable
            ? `${packageId} has no published version yet: pull its draft (appstrate packages pull ${packageId}).`
            : `${packageId} has no published version yet, and only its authors read its draft.`,
        );
      }
      files = published;
    }

    const { written, removed, skipped } = await writeDefinition(dir, files, existing);
    if (lock !== undefined) await recordLock(session.profileName, dir, packageId, lock);
    else await forgetLock(session.profileName, dir);

    const version = definitionVersion(files);
    const what = readsDraft ? "draft" : `published ${version ?? spec ?? "latest"}`;
    io.stdout.write(`Pulled ${packageId} (${home.type}, ${what}, ${written} files) into ${dir}\n`);
    if (removed.length > 0) {
      io.stderr.write(
        `Removed ${removed.length} file(s) the package does not have: ${removed.join(", ")}\n`,
      );
    }
    if (skipped.length > 0) {
      io.stderr.write(`Not written (ignored by the authoring loop): ${skipped.join(", ")}\n`);
    }
    if (!home.home_writable) {
      io.stderr.write(
        "Read-only: you cannot write this package in its home space. Ask its owners to add you as a co-editor to push changes.\n",
      );
    } else if (!readsDraft) {
      io.stderr.write(
        "This is a published version, not the draft: pushing from it needs --force, which replaces the draft with this folder.\n",
      );
    } else {
      io.stderr.write(
        `Edit it there, then: appstrate packages push ${opts.dir ? dir : packageId}\n`,
      );
    }
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

/**
 * A published version, read in a space that reads the package; `null` when
 * `latest` does not exist because nothing was ever published.
 */
async function fetchPublished(
  session: Session,
  home: PackageHome,
  version: string,
): Promise<PackageFiles | null> {
  try {
    return await fetchPackageDefinition(session.profileName, {
      packageId: home.id,
      spaceId: readSpaceOf(home, session.profile.spaceId),
      source: "published",
      version,
    });
  } catch (err) {
    if (err instanceof PackageDefinitionError && err.status === 404 && version === "latest") {
      return null;
    }
    throw err;
  }
}

/** The definition's `manifest.json` version, for the messages. */
function definitionVersion(files: PackageFiles): string | undefined {
  const raw = files[PACKAGE_MANIFEST_FILE];
  if (!raw) return undefined;
  try {
    const version = (JSON.parse(new TextDecoder().decode(raw)) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Absent → `null`, created on write. Holding files (ignored entries aside) →
 * refused unless `force`; with `force`, its files, which the pull mirrors.
 */
async function prepareDestination(
  dir: string,
  force: boolean,
): Promise<Map<string, string> | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dir);
  } catch (err) {
    if (isAbsent(err)) return null;
    throw new Error(`${dir}: cannot be read.`, { cause: err });
  }
  if (!info.isDirectory()) throw new Error(`${dir}: not a directory.`);
  const entries = (await readdir(dir)).filter((entry) => !isIgnoredPath(entry));
  if (entries.length === 0) return null;
  if (!force) {
    throw new Error(
      `${dir} is not empty. Pick another folder, or re-run with --force: the folder then mirrors the package, and files it does not have are deleted.`,
    );
  }
  return listFolderFiles(dir);
}

/**
 * Mirror the definition into `dir`. Ignored entries are never written — a
 * definition could otherwise plant a `.git/config` or an editor task that runs
 * on open — and are reported, `RECORD` aside. Removals are decided and done
 * FIRST, by NFC path: on a disk that folds normalization or case, the file the
 * write below lands on is then never the one a later removal deletes.
 */
async function writeDefinition(
  dir: string,
  files: PackageFiles,
  existing: Map<string, string> | null,
): Promise<{ written: number; removed: string[]; skipped: string[] }> {
  const all = Object.keys(files).sort(byCodeUnit);
  const paths = all.filter((path) => !isIgnoredPath(path));
  const skipped = all.filter((path) => isIgnoredPath(path) && path !== SIGNATURE_RECORD);
  // All checked before the first change: a refused entry leaves the folder as it was.
  const byCanonical = new Map<string, string>();
  for (const path of paths) {
    if (!isSafeArchivePath(path)) throw new Error(`Refusing archive entry "${path}".`);
    // A case- or normalization-insensitive disk (macOS, Windows) holds one of
    // the two, and the second write would silently replace the first.
    const twin = byCanonical.get(canonicalPackagePath(path));
    if (twin !== undefined) {
      throw new Error(
        `Refusing to pull: "${twin}" and "${path}" are one file on a case- or normalization-insensitive disk. Rename one of them in the package first.`,
      );
    }
    byCanonical.set(canonicalPackagePath(path), path);
  }
  const incoming = new Set(paths.map((path) => path.normalize("NFC")));
  const removed = [...(existing?.keys() ?? [])]
    .filter((path) => !incoming.has(path.normalize("NFC")))
    .sort(byCodeUnit);
  for (const path of removed) {
    const full = existing!.get(path)!;
    await rm(full, { force: true });
    await pruneEmptyParents(dirname(full), dir);
  }
  await mkdir(dir, { recursive: true });
  for (const path of paths) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, files[path]!);
  }
  return { written: paths.length, removed, skipped };
}

/** Remove the directories a deletion emptied, up to (never including) `root`. */
async function pruneEmptyParents(from: string, root: string): Promise<void> {
  let current = from;
  while (current !== root && current.startsWith(root)) {
    try {
      await rmdir(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
      throw err;
    }
    current = dirname(current);
  }
}

// ─── status ──────────────────────────────────────────────────────────────

export interface PackagesStatusOptions {
  profile?: string;
  /** Folder, or a bare package name resolved in the work dir. */
  dir: string;
  /** Print a line diff for each modified text file. */
  diff?: boolean;
}

export async function packagesStatusCommand(
  opts: PackagesStatusOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    const local = await readLocalPackage(session, opts.dir);
    const lines = [`${local.packageId} (${local.type}) ← ${local.dir}`];
    const home = await resolvePackage(session.profileName, local.packageId);
    if (!home) {
      lines.push("  not on Appstrate: push --create creates it AND publishes its first version");
      for (const path of Object.keys(local.files).sort(byCodeUnit)) lines.push(`  A ${path}`);
      io.stdout.write(`${lines.join("\n")}\n`);
      return;
    }
    assertSameType(local, home);

    let remote: PackageFiles;
    if (home.home_writable) {
      const now = (await readDraftState(session.profileName, home)).etag;
      remote = await fetchPackageDefinition(session.profileName, {
        packageId: home.id,
        type: home.type,
        spaceId: home.home_space_id ?? undefined,
        source: "draft",
        refusalRemedy: draftRemedyPull(home.id),
      });
      const seen = await readLock(session.profileName, local.dir, home.id);
      if (seen === undefined) {
        lines.push(
          "  ! this folder never pulled this draft: push --force replaces the draft with this folder",
        );
      } else if (seen !== now) {
        lines.push(
          `  ! the draft was edited elsewhere since this folder last saw it (${seen} → ${now}): pull it into another folder to compare, or push --force to replace it`,
        );
      }
    } else {
      const published = await fetchPublished(session, home, "latest");
      if (!published) {
        lines.push(
          "  read-only, and nothing is published yet: only the package's authors read its draft",
        );
        io.stdout.write(`${lines.join("\n")}\n`);
        return;
      }
      remote = published;
      lines.push(
        `  read-only: compared to the latest published version (${definitionVersion(remote) ?? "?"}); you cannot push to this package`,
      );
    }

    const changes = diffFiles(local.files, remote);
    if (changes.length === 0) {
      lines.push(
        `  clean: the folder matches the ${home.home_writable ? "draft" : "published version"}`,
      );
    } else {
      lines.push(...renderChanges(changes, local.files, remote, opts.diff === true));
    }
    io.stdout.write(`${lines.join("\n")}\n`);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

function renderChanges(
  changes: FileChange[],
  local: PackageFiles,
  remote: PackageFiles,
  withDiff: boolean,
): string[] {
  const glyph = { modified: "M", added: "A", removed: "D" } as const;
  const lines = changes.map((change) => `  ${glyph[change.kind]} ${change.path}`);
  if (!withDiff) return lines;
  for (const change of changes) {
    if (change.kind !== "modified") continue;
    const mine = local[change.localPath ?? change.path]!;
    const theirs = remote[change.path]!;
    const mineText = decodePackageFileText(mine);
    const theirsText = decodePackageFileText(theirs);
    if (mineText === null || theirsText === null) {
      lines.push(`--- ${change.path}: binary, ${theirs.byteLength} → ${mine.byteLength} bytes`);
      continue;
    }
    lines.push(`--- remote/${change.path}`, `+++ local/${change.path}`);
    lines.push(...lineDiff(theirsText.split("\n"), mineText.split("\n")));
  }
  return lines;
}

/** Past this many LCS cells, a line diff costs more than it tells. */
const LINE_DIFF_MAX_CELLS = 4_000_000;

/** Minimal LCS line diff: package files are small, quadratic is fine — up to a cap. */
export function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if (n * m > LINE_DIFF_MAX_CELLS) return [`  diff too large: ${n} → ${m} lines`];
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

// ─── push ────────────────────────────────────────────────────────────────

export interface PackagesPushOptions {
  profile?: string;
  /** Folder, or a bare package name resolved in the work dir. */
  dir: string;
  /** Create the package when it does not exist. Creating publishes its first version. */
  create?: boolean;
  /** With `create`: the space that becomes the package's home. Default: the pinned space. */
  space?: string;
  /** Replace the draft with the folder even though this folder did not see its current state. */
  force?: boolean;
  /** Show what would be sent and send nothing. */
  dryRun?: boolean;
}

export async function packagesPushCommand(
  opts: PackagesPushOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    if (opts.space !== undefined && !opts.create) {
      throw new Error("--space only applies with --create: it names the new package's home.");
    }
    const local = await readLocalPackage(session, opts.dir);
    const { dir, files, type, packageId } = local;
    const entry = PACKAGE_CONTENT_ENTRY[type];
    if (entry?.required && !files[entry.path]) {
      throw new Error(`${dir}: a ${type} folder needs ${entry.path}.`);
    }

    const home = await resolvePackage(session.profileName, packageId);
    if (!home) {
      await createPackage(session, local, opts, io);
      return;
    }
    assertSameType(local, home);
    if (!home.home_writable) {
      throw new Error(
        `You cannot write ${packageId} in its home space. Ask its owners to add you as a co-editor.`,
      );
    }

    const known = await readLock(session.profileName, dir, packageId);
    if (known === undefined && !opts.force) {
      throw new Error(
        `This folder never pulled the draft of ${packageId}: pushing would replace a draft it has not seen. To replace the draft with this folder anyway: appstrate packages push ${opts.dir} --force`,
      );
    }
    const state = await readDraftState(session.profileName, home);
    const lock = opts.force ? state.etag : known!;
    const draft = await fetchPackageDefinition(session.profileName, {
      packageId,
      type,
      spaceId: home.home_space_id ?? undefined,
      source: "draft",
      refusalRemedy: draftRemedyPull(packageId),
    });

    const changes = diffFiles(files, draft);
    const operations = toOperations(changes, files);
    const manifestChanged = changes.some((change) => change.path === PACKAGE_MANIFEST_FILE);
    if (operations.length === 0 && !manifestChanged) {
      // The folder IS the current draft, so it has seen it.
      if (!opts.dryRun) await recordLock(session.profileName, dir, packageId, state.etag);
      io.stdout.write(`Nothing to push: ${packageId} matches its draft.\n`);
      return;
    }
    const summary = `${operations.length} file operation(s)${manifestChanged ? " and the manifest" : ""}`;
    if (opts.dryRun) {
      io.stdout.write(`Would write ${summary} to the draft of ${packageId} (dry run).\n`);
      return;
    }

    const body: Record<string, unknown> = {};
    if (manifestChanged) body.manifest = folderManifest(files);
    if (operations.length > 0) body.operations = operations;
    let written: { body: DraftDetail; headers: Headers };
    try {
      written = await apiFetchWithHeaders<DraftDetail>(
        session.profileName,
        packageRoute(type, packageId),
        {
          method: "PATCH",
          headers: { "If-Match": lock },
          body: JSON.stringify(body),
          ...(home.home_space_id ? { spaceId: home.home_space_id } : {}),
        },
      );
    } catch (err) {
      // 412 is the stale version; any other refusal is the problem it names.
      if (err instanceof ApiError && err.status === 412) {
        throw new ExplainedError(
          `The draft of ${packageId} was edited elsewhere since this folder last saw it. Pull it into another folder to compare, or push --force to replace it.`,
          { cause: err },
        );
      }
      if (err instanceof ApiError) {
        throw new Error(`Push of ${packageId} refused: ${describeProblem(err)}`, {
          cause: err,
        });
      }
      throw err;
    }
    // The response's ETag is the version THIS write produced (the server stamps
    // it from the write, not from the re-read body), so a later write by someone
    // else still refuses this folder's next push.
    const after = draftStateOf(packageId, written.body, written.headers);
    await recordLock(session.profileName, dir, packageId, after.etag);
    // The server stores the VALIDATED manifest, which may normalize what the
    // author wrote: writing it back keeps the next status clean.
    if (PACKAGE_MANIFEST_FILE in files) await rewriteManifest(dir, after.manifest);

    io.stdout.write(`Pushed ${summary} to the draft of ${packageId}.\n`);
    io.stderr.write(
      type === "skill"
        ? `Test it here: appstrate packages sync --source draft. Then: appstrate packages publish ${packageId}\n`
        : `Test the draft on Appstrate, then: appstrate packages publish ${packageId}\n`,
    );
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

/**
 * `push --create`: the folder, zipped, through the import route — the one
 * creation path every type has (an MCP server has no other), which homes the
 * package in the space named and PUBLISHES its first version. The folder then
 * records the new draft's lock and gets the manifest the server stored, which
 * for a `SKILL.md`-only folder is one it synthesized.
 */
async function createPackage(
  session: Session,
  local: LocalPackage,
  opts: PackagesPushOptions,
  io: CommandIO,
): Promise<void> {
  const { dir, files, packageId } = local;
  if (!opts.create) {
    throw new Error(
      `${packageId} does not exist. Creating a package also publishes its first version: re-run with --create to do so.`,
    );
  }
  const spaceId = opts.space ?? session.profile.spaceId;
  const where = spaceId ? ` in space ${spaceId}` : "";
  if (opts.dryRun) {
    io.stdout.write(`Would create ${packageId}${where} and publish its first version (dry run).\n`);
    return;
  }
  const ignored: string[] = [];
  await listFolderFiles(dir, ignored);
  if (ignored.length > 0) {
    io.stderr.write(`Not sent (ignored by the authoring loop): ${ignored.join(", ")}\n`);
  }
  const form = new FormData();
  const name = parseScopedName(packageId)!.name;
  form.append(
    "file",
    new File([new Uint8Array(zipArtifact(files))], `${name}.zip`, { type: "application/zip" }),
  );
  type Imported = { packageId?: unknown; version?: unknown; warnings?: unknown };
  let created: Imported;
  try {
    created = await apiFetch<Imported>(session.profileName, "/api/packages/import", {
      method: "POST",
      body: form,
      ...(spaceId ? { spaceId } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      throw new Error(`Creating ${packageId} was refused: ${describeProblem(err)}`, {
        cause: err,
      });
    }
    throw err;
  }
  if (typeof created.packageId !== "string") {
    throw new Error(`${packageId}: the import response carries no packageId.`);
  }
  const createdId = created.packageId;
  const home = await resolvePackage(session.profileName, createdId);
  if (!home) throw new Error(`${createdId} was created, but it cannot be read back.`);
  const state = await readDraftState(session.profileName, home);
  await recordLock(session.profileName, dir, createdId, state.etag);
  await rewriteManifest(dir, state.manifest);

  const version = typeof created.version === "string" ? ` ${created.version}` : "";
  io.stdout.write(`Created ${createdId}${where} and published its first version${version}.\n`);
  if (Array.isArray(created.warnings)) {
    for (const warning of created.warnings) {
      io.stderr.write(
        `warning: ${typeof warning === "string" ? warning : JSON.stringify(warning)}\n`,
      );
    }
  }
}

// ─── publish ─────────────────────────────────────────────────────────────

export interface PackagesPublishOptions {
  profile?: string;
  /** A working folder, or `@scope/name`, or a bare name (its working copy, else the id under the org's slug). */
  package: string;
  /** Segment bumped when the draft still carries the published version. Default `patch`, as in the dashboard. */
  bump?: string;
}

const BUMPS: readonly VersionBump[] = ["patch", "minor", "major"];

function isBump(value: string): value is VersionBump {
  return (BUMPS as readonly string[]).includes(value);
}

/**
 * A working folder names its package through its files; anything else is an
 * id. `@scope/name` is always an id: publishing by id publishes the draft as
 * it is, whatever any folder holds.
 */
async function publishTarget(
  session: Session,
  target: string,
): Promise<{ packageId: string; folder?: LocalPackage }> {
  let folder: ResolvedFolder | null = null;
  if (isPathLike(target)) folder = { dir: resolve(expandHome(target)) };
  else if (!target.startsWith("@")) {
    folder = (await isDirectory(resolve(target)))
      ? { dir: resolve(target) }
      : await findWorkingCopy(session, target);
  }
  if (!folder) return { packageId: await resolvePackageId(session, target) };
  const local = await readFolderPackage(session, folder);
  return { packageId: local.packageId, folder: local };
}

export async function packagesPublishCommand(
  opts: PackagesPublishOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    const bump = opts.bump ?? "patch";
    if (!isBump(bump)) throw new Error(`--bump must be one of ${BUMPS.join(", ")}.`);
    const { packageId, folder } = await publishTarget(session, opts.package);
    const home = await resolvePackage(session.profileName, packageId);
    if (!home) throw new Error(`${packageId}: no package with this id that you can read.`);
    if (!home.home_writable) {
      throw new Error(
        `You cannot publish ${packageId}: that needs \`${PACKAGE_TYPE_ROUTE_SEGMENT[home.type]}:write\` in its home space.`,
      );
    }
    const route = packageRoute(home.type, packageId);
    const inHome = home.home_space_id ? { spaceId: home.home_space_id } : {};
    const before = await readDraftState(session.profileName, home);
    // Publishing FROM a folder promises that folder's content: one that the
    // draft does not hold — unpushed edits, or a draft moved since it was read —
    // would cut a version its author did not look at.
    if (folder) {
      assertSameType(folder, home);
      const seen = await readLock(session.profileName, folder.dir, packageId);
      const draft = await fetchPackageDefinition(session.profileName, {
        packageId,
        type: home.type,
        spaceId: home.home_space_id ?? undefined,
        source: "draft",
        refusalRemedy: draftRemedyPull(packageId),
      });
      if (seen !== before.etag || diffFiles(folder.files, draft).length > 0) {
        throw new Error(
          `${folder.dir} has changes the draft does not have: push them first, or publish by id (${packageId}) to publish the draft as it is.`,
        );
      }
    }
    // The dashboard's publish button is off for a draft that has not moved
    // since the latest version, and so is this command. Asked after the folder
    // check, so a folder ahead of its draft is told to push, not that nothing
    // changed.
    if (!before.hasUnpublishedChanges) {
      throw new Error(
        `Nothing changed in the draft of ${packageId} since its latest version: there is nothing to publish.`,
      );
    }

    const info = await apiFetch<PackageVersionInfoResponse>(
      session.profileName,
      `${route}/versions/info`,
      inHome,
    );
    const plan = planPublishVersion(info.active_version, info.latest_published_version, bump);
    if (plan.kind === "none") {
      throw new Error(
        `The draft manifest of ${packageId} has no valid \`version\`${info.active_version ? ` ("${info.active_version}")` : ""}. Set one in manifest.json and push.`,
      );
    }
    if (plan.kind === "blocked") {
      throw new Error(
        `The draft of ${packageId} is at ${info.active_version}, behind the latest published ${info.latest_published_version}, and versions only move forward. Set a \`version\` above ${info.latest_published_version} in manifest.json and push.`,
      );
    }
    const { override, target } = plan;

    // `If-Match`: the version cut is the draft read above — a draft moved since
    // (a push landing in between) is refused with 412, never published unseen.
    let created: { version?: unknown };
    try {
      created = await apiFetch<{ version?: unknown }>(session.profileName, `${route}/versions`, {
        method: "POST",
        headers: { "If-Match": before.etag },
        body: JSON.stringify(override !== undefined ? { version: override } : {}),
        ...inHome,
      });
    } catch (err) {
      if (err instanceof ApiError) throw publishRefusal(err, packageId, target);
      throw err;
    }
    if (typeof created.version !== "string") {
      throw new Error(`${packageId}: the publish response carries no version.`);
    }
    const version = created.version;

    // The draft is exactly the version just cut (nothing unpublished) and carries
    // its number: the publish's own rewrite, not an edit folders never saw.
    if (override !== undefined && before.manifest.version !== version) {
      const after = await readDraftState(session.profileName, home);
      if (!after.hasUnpublishedChanges && after.manifest.version === version) {
        await advanceLocks(session.profileName, packageId, before.etag, after.etag, (dir) =>
          carryVersion(dir, before.manifest.version, version, io),
        );
      }
    }
    io.stdout.write(`Published ${packageId}@${version}\n`);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

/**
 * Move a folder's `manifest.json` from the draft's old version to its new one,
 * touching nothing else: the folder's other manifest edits are its own, not yet
 * pushed. A folder whose version already differs chose its own, and one
 * without a manifest has none to carry. Any other failure is a warning: the
 * version is published, and that is not undone by a folder it could not update.
 */
async function carryVersion(
  dir: string,
  from: unknown,
  to: string,
  io: CommandIO,
): Promise<boolean> {
  const path = join(dir, PACKAGE_MANIFEST_FILE);
  try {
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await readFile(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    const manifest = folderManifest({ [PACKAGE_MANIFEST_FILE]: raw });
    if (!manifest) return false;
    if (manifest.version !== from) return true;
    await writeFile(path, manifestFileText({ ...manifest, version: to }));
    io.stderr.write(`Updated the version in ${path} to ${to}.\n`);
    return true;
  } catch (err) {
    io.stderr.write(
      `warning: could not carry version ${to} into ${dir}: ${formatError(err)}. Pull it again before pushing from it.\n`,
    );
    return false;
  }
}

function publishRefusal(err: ApiError, packageId: string, target: string | undefined): Error {
  const { code } = problemFields(err.body);
  const cut = target ? ` ${target}` : "";
  switch (code) {
    case "version_exists":
      return new ExplainedError(
        `Version${cut} of ${packageId} is already published. Set a higher \`version\` in manifest.json and push.`,
        { cause: err },
      );
    case "no_changes":
      return new ExplainedError(
        `Nothing changed in the draft of ${packageId} since its latest version: there is nothing to publish.`,
        { cause: err },
      );
    case "precondition_failed":
      return new ExplainedError(
        `The draft of ${packageId} changed while this command read it (a push or an edit landed in between): nothing was published. Check it and publish again.`,
        { cause: err },
      );
    case "agent_in_use":
      // A plain Error on purpose: the server's detail carries the run count.
      return new Error(`${packageId} has runs in progress; retry when they finish.`, {
        cause: err,
      });
    default:
      return new Error(`Publishing ${packageId} was refused: ${describeProblem(err)}`, {
        cause: err,
      });
  }
}
