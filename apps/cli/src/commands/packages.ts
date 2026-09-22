// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate packages pull | status | push | publish` — the authoring loop: a
 * package (skill, agent, integration, MCP server) is edited in a local working
 * folder and written back to its DRAFT, then published as a deliberate step.
 *
 *   pull     the draft (or a published version) → a working folder
 *   status   what the folder would change in the draft, computed on demand
 *   push     the folder → the draft, under the lock this machine last saw
 *   publish  the draft → a version everyone resolves
 *
 * Authority is the package's HOME space: only a caller who may write there can
 * read the draft, push or publish; everyone else gets the published version,
 * read-only. Sharing and activation stay out of this loop — they belong to the
 * share and placement routes.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extractSkillMeta } from "@appstrate/core/validation";
import { parseScopedName } from "@appstrate/core/naming";
import { apiFetch, ApiError } from "../lib/api.ts";
import {
  packageWorkDir,
  readConfig,
  resolveActiveProfile,
  resolveWorkDir,
  type Profile,
} from "../lib/config.ts";
import { PROJECT_FILE_RELPATH } from "../lib/install/project.ts";
import { listOrgs } from "../lib/orgs.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { formatError } from "../lib/ui.ts";
import {
  bumpPatch,
  canonicalJson,
  chunk,
  CONTENT_ENTRY,
  diffFiles,
  fetchPackageFiles,
  frontmatterVersion,
  latestPublished,
  locatePackage,
  MANIFEST,
  MAX_OPERATIONS_PER_PUT,
  packageCollectionPath,
  PACKAGE_TYPES,
  packagePath,
  readLock,
  readPackageFolder,
  recordLock,
  toLocated,
  toOperations,
  typeOfFolder,
  writeOperation,
  type FileChange,
  type LocatedPackage,
  type PackageType,
} from "../lib/packages.ts";

interface Session {
  profileName: string;
  profile: Profile;
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
  const org = (await listOrgs(session.profileName)).find((o) => o.id === session.profile.orgId);
  if (!org) {
    throw new Error(
      `Organization ${session.profile.orgId} is not one this profile belongs to. Run: appstrate org switch`,
    );
  }
  return org.slug;
}

/** `@scope/name` as given, a bare name under the organization's slug. */
async function resolvePackageId(session: Session, ref: string): Promise<string> {
  const packageId = ref.startsWith("@") ? ref : `@${await orgSlug(session)}/${ref}`;
  if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${ref}`);
  return packageId;
}

/** `~/Appstrate` is an instance directory that `uninstall --purge` removes: never a work dir. */
async function assertNotInstallDir(workDir: string): Promise<void> {
  try {
    await stat(join(workDir, PROJECT_FILE_RELPATH));
  } catch {
    return;
  }
  throw new Error(
    `${workDir} is an Appstrate instance directory (it has ${PROJECT_FILE_RELPATH}); \`appstrate uninstall --purge\` would delete your working copies. Set workDir in config.toml to another folder.`,
  );
}

/**
 * A path is used as given. A bare name (no separator, not a folder here) is the
 * package's working copy in the work dir, the folder `packages pull` fills.
 */
async function resolveFolder(session: Session, target: string): Promise<string> {
  const looksLikePath = target.includes("/") || target.startsWith(".") || target.startsWith("~");
  if (looksLikePath) {
    return resolve(
      target.startsWith("~/") ? join(process.env.HOME ?? "", target.slice(2)) : target,
    );
  }
  try {
    if ((await stat(target)).isDirectory()) return resolve(target);
  } catch {
    // Not a folder here: the work dir below.
  }
  const name = target.startsWith("@") ? parseScopedName(target)?.name : target;
  if (!name) throw new Error(`Not a package name: ${target}`);
  const config = await readConfig();
  await assertNotInstallDir(resolveWorkDir(config));
  const slug = await orgSlug(session);
  for (const type of PACKAGE_TYPES) {
    const dir = packageWorkDir(config, slug, type, name);
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // Next type's folder.
    }
  }
  throw new Error(
    `No working copy for ${target} in ${resolveWorkDir(config)}. Run: appstrate packages pull ${target}, or pass a folder path.`,
  );
}

// ─── pull ────────────────────────────────────────────────────────────────

export interface PackagesPullOptions {
  profile?: string;
  /** `@scope/name`, or a bare name under the organization's slug. */
  package: string;
  /** Destination folder. Default: `<workDir>/<org slug>/packages/<type>s/<name>`. */
  dir?: string;
  /** A published version (`latest`, exact, range) instead of the draft. */
  version?: string;
  /** Write into a folder that already has files, replacing same-named ones. */
  force?: boolean;
}

export async function packagesPullCommand(
  opts: PackagesPullOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    const packageId = await resolvePackageId(session, opts.package);
    const located = await locatePackage(session.profileName, packageId);
    if (!located) throw new Error(`${packageId}: no package with this id that you can read.`);

    // The draft is the author's: read it when this caller may write the
    // package and asked for no version. Everyone else reads what is published.
    const readsDraft = located.homeWritable && opts.version === undefined;
    const selector = readsDraft ? "draft" : (opts.version ?? "latest");

    let dir: string;
    if (opts.dir) dir = resolve(opts.dir);
    else {
      const config = await readConfig();
      await assertNotInstallDir(resolveWorkDir(config));
      const name = parseScopedName(packageId)!.name;
      dir = packageWorkDir(config, await orgSlug(session), located.type, name);
    }
    await assertWritable(dir, opts.force === true);

    const files = await fetchPackageFiles(session.profileName, located, selector);
    const paths = Object.keys(files).sort();
    for (const path of paths) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, files[path]!);
    }
    if (readsDraft && located.lockVersion !== undefined) {
      await recordLock(session.profileName, dir, packageId, located.lockVersion);
    }

    const what = readsDraft ? "draft" : `published ${selector}`;
    io.stdout.write(
      `Pulled ${packageId} (${located.type}, ${what}, ${paths.length} files) into ${dir}\n`,
    );
    if (!located.homeWritable) {
      io.stderr.write(
        "Read-only: you cannot write this package in its home space. Ask its owners to add you as a co-editor to push changes.\n",
      );
    } else if (!readsDraft) {
      io.stderr.write(
        "This is a published version, not the draft: pushing from it needs --force, which replaces whatever the draft holds.\n",
      );
    } else {
      io.stderr.write(
        `Edit it there, then: appstrate packages push ${opts.dir ? dir : parseScopedName(packageId)!.name}\n`,
      );
    }
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

/** Empty or absent, unless `force`: a working folder is not overwritten by accident. */
async function assertWritable(dir: string, force: boolean): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dir);
  } catch {
    return;
  }
  if (!info.isDirectory()) throw new Error(`${dir}: not a directory.`);
  if (force) return;
  const entries = (await readdir(dir)).filter((entry) => entry !== ".DS_Store");
  if (entries.length > 0) {
    throw new Error(
      `${dir} is not empty. Pick another folder, or re-run with --force to overwrite its files.`,
    );
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

export interface PackageStatus {
  packageId: string;
  type: PackageType;
  /** No readable package with this id: a push would have to create it. */
  located: LocatedPackage | null;
  changes: FileChange[];
  /** The draft's lock is not the one this machine last read or wrote. */
  remoteMoved: { seen: number; now: number } | null;
  /** This machine never read this draft: a push would overwrite it blind. */
  neverSeen: boolean;
  /** What the folder is compared to, for diffs. Empty when not located. */
  remote: Record<string, Uint8Array>;
}

export async function packagesStatusCommand(
  opts: PackagesStatusOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    const dir = await resolveFolder(session, opts.dir);
    const files = await readPackageFolder(dir);
    const status = await computeStatus(session, dir, files);
    io.stdout.write(renderStatus(status, dir, files, opts.diff === true));
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

async function computeStatus(
  session: Session,
  dir: string,
  files: Record<string, Uint8Array>,
): Promise<PackageStatus> {
  const type = typeOfFolder(files);
  if (!type) throw new Error("No manifest.json with a known `type`, and no SKILL.md.");
  const packageId = await packageIdOf(session, files);
  const located = await locatePackage(session.profileName, packageId, type);
  if (located && located.type !== type) {
    throw new Error(
      `${packageId} is a ${located.type} on Appstrate, but this folder is a ${type}.`,
    );
  }
  if (!located) {
    return {
      packageId,
      type,
      located: null,
      changes: Object.keys(files)
        .sort()
        .map((path) => ({ path, kind: "added" as const })),
      remoteMoved: null,
      neverSeen: false,
      remote: {},
    };
  }
  const remote = await fetchPackageFiles(
    session.profileName,
    located,
    located.homeWritable ? "draft" : "latest",
  );
  const seen = await readLock(session.profileName, dir, packageId);
  const now = located.lockVersion;
  return {
    packageId,
    type,
    located,
    changes: diffFiles(files, remote),
    remoteMoved: seen !== undefined && now !== undefined && seen !== now ? { seen, now } : null,
    neverSeen: located.homeWritable && seen === undefined,
    remote,
  };
}

function renderStatus(
  status: PackageStatus,
  dir: string,
  local: Record<string, Uint8Array>,
  withDiff: boolean,
): string {
  const lines = [`${status.packageId} (${status.type}) ← ${dir}`];
  if (!status.located) {
    lines.push("  not on Appstrate: push --create would create it AND publish its first version");
  } else if (!status.located.homeWritable) {
    lines.push(
      "  read-only: compared to the latest published version; you cannot push to this package",
    );
  }
  if (status.remoteMoved) {
    lines.push(
      `  ! the draft was edited elsewhere since this machine last saw it (lock ${status.remoteMoved.seen} → ${status.remoteMoved.now}): pull again, or push --force to replace it`,
    );
  }
  if (status.neverSeen) {
    lines.push(
      "  ! this machine never pulled this draft: push needs --force, which replaces the draft",
    );
  }
  if (status.located && status.changes.length === 0) {
    lines.push(
      `  clean: the folder matches the ${status.located.homeWritable ? "draft" : "published version"}`,
    );
    return `${lines.join("\n")}\n`;
  }
  const glyph = { modified: "M", added: "A", removed: "D" } as const;
  for (const change of status.changes) lines.push(`  ${glyph[change.kind]} ${change.path}`);
  if (withDiff) {
    const decoder = new TextDecoder();
    for (const change of status.changes) {
      if (change.kind !== "modified") continue;
      const mine = local[change.path]!;
      const theirs = status.remote[change.path]!;
      const mineOp = writeOperation(change.path, mine);
      const theirsOp = writeOperation(change.path, theirs);
      if (!("text" in mineOp) || !("text" in theirsOp)) {
        lines.push(`--- ${change.path}: binary, ${theirs.byteLength} → ${mine.byteLength} bytes`);
        continue;
      }
      lines.push(`--- remote/${change.path}`, `+++ local/${change.path}`);
      lines.push(...lineDiff(decoder.decode(theirs).split("\n"), decoder.decode(mine).split("\n")));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The folder's id: its manifest's `name`, else `@<org slug>/<SKILL.md frontmatter name>`. */
async function packageIdOf(session: Session, files: Record<string, Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const manifestRaw = files[MANIFEST];
  if (manifestRaw) {
    let parsed: { name?: unknown };
    try {
      parsed = JSON.parse(decoder.decode(manifestRaw)) as { name?: unknown };
    } catch {
      throw new Error(`${MANIFEST} is not valid JSON.`);
    }
    if (typeof parsed.name !== "string" || !parseScopedName(parsed.name)) {
      throw new Error(`${MANIFEST}: \`name\` must be @scope/name.`);
    }
    return parsed.name;
  }
  const meta = extractSkillMeta(decoder.decode(files["SKILL.md"]!));
  if (!meta.name) throw new Error("SKILL.md: frontmatter has no `name`.");
  return `@${await orgSlug(session)}/${meta.name}`;
}

/** Minimal LCS line diff: package files are small, quadratic is fine. */
export function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
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
  /** Replace the draft even though this machine did not see its current state. */
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
    const dir = await resolveFolder(session, opts.dir);
    const files = await readPackageFolder(dir);
    const type = typeOfFolder(files);
    if (!type) throw new Error(`${dir}: no manifest.json with a known \`type\`, and no SKILL.md.`);
    const entry = CONTENT_ENTRY[type];
    if (entry && !files[entry]) throw new Error(`${dir}: a ${type} folder needs ${entry}.`);

    const status = await computeStatus(session, dir, files);
    const { packageId, located } = status;
    io.stderr.write(renderStatus(status, dir, files, false));

    const manifest = await manifestToSend(session, files, type, packageId, located);

    if (!located) {
      if (!opts.create) {
        throw new Error(
          `${packageId} does not exist. Creating a package publishes its first version (${manifest.version}) right away: re-run with --create to do so.`,
        );
      }
      if (opts.dryRun) {
        io.stdout.write(`Would create ${packageId} and publish ${manifest.version} (dry run).\n`);
        return;
      }
      const created = await createPackage(session, type, manifest, files, entry, opts.space);
      if (created.lockVersion !== undefined)
        await recordLock(session.profileName, dir, packageId, created.lockVersion);
      await rewriteManifest(dir, created.manifest);
      io.stdout.write(`Created ${packageId} and published ${manifest.version} (${type}).\n`);
      return;
    }

    if (!located.homeWritable) {
      throw new Error(
        `You cannot write ${packageId} in its home space (${located.homeSpaceId}). Ask its owners to add you as a co-editor.`,
      );
    }

    const known = await readLock(session.profileName, dir, packageId);
    if (known === undefined && !opts.force) {
      throw new Error(
        `This machine never pulled the draft of ${packageId}: pushing would replace it without having seen it. Run: appstrate packages pull ${packageId} --force (your files win on conflict), or push --force.`,
      );
    }
    const lock = opts.force ? located.lockVersion : known;
    if (lock === undefined) throw new Error(`${packageId}: the draft carries no lock_version.`);

    const operations = toOperations(status.changes, files);
    const manifestChanged =
      located.manifest === undefined || canonicalJson(manifest) !== canonicalJson(located.manifest);
    if (operations.length === 0 && !manifestChanged) {
      io.stdout.write(`Nothing to push: ${packageId} matches its draft.\n`);
      return;
    }
    if (opts.dryRun) {
      io.stdout.write(
        `Would write ${operations.length} file operation(s) to the draft of ${packageId}${manifestChanged ? " and its manifest" : ""} (dry run).\n`,
      );
      return;
    }

    // One PUT per batch of operations, each under the lock the previous one
    // returned. The manifest rides the first batch.
    let current = lock;
    let written: LocatedPackage | undefined;
    const batches = operations.length === 0 ? [[]] : chunk(operations, MAX_OPERATIONS_PER_PUT);
    for (const [index, batch] of batches.entries()) {
      const body: Record<string, unknown> = { lock_version: current };
      if (index === 0) body.manifest = manifest;
      if (batch.length > 0) body.operations = batch;
      let detail: Parameters<typeof toLocated>[2];
      try {
        detail = await apiFetch(session.profileName, packagePath(type, packageId), {
          method: "PUT",
          body: JSON.stringify(body),
          spaceId: located.homeSpaceId,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          throw new Error(
            `The draft of ${packageId} was edited elsewhere since this folder last saw it. Pull it again, or push --force to replace it`,
            { cause: err },
          );
        }
        throw err;
      }
      written = toLocated(packageId, type, detail);
      if (written.lockVersion === undefined)
        throw new Error(`${packageId}: the update returned no lock_version.`);
      current = written.lockVersion;
    }
    await recordLock(session.profileName, dir, packageId, current);
    await rewriteManifest(dir, written?.manifest);

    io.stdout.write(
      `Pushed ${packageId} to its draft (${operations.length} file operation(s), would publish as ${manifest.version}).\n`,
    );
    io.stderr.write(
      type === "skill"
        ? `Test it here: appstrate skills sync --source draft. Then: appstrate packages publish ${packageId}\n`
        : `Test the draft on Appstrate, then: appstrate packages publish ${packageId}\n`,
    );
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

/**
 * The manifest the draft gets. The folder's own `manifest.json` passes through;
 * a skill folder without one gets a minimal manifest from its frontmatter. A
 * version that is already published moves to the next patch, so that push then
 * publish works without editing the version by hand.
 */
async function manifestToSend(
  session: Session,
  files: Record<string, Uint8Array>,
  type: PackageType,
  packageId: string,
  located: LocatedPackage | null,
): Promise<Record<string, unknown>> {
  const latest = located
    ? await latestPublished(session.profileName, type, packageId, located.homeSpaceId)
    : null;
  const authored = files[MANIFEST];
  if (authored) {
    const manifest = JSON.parse(new TextDecoder().decode(authored)) as Record<string, unknown>;
    if (typeof manifest.version !== "string")
      throw new Error(`${MANIFEST}: \`version\` is required.`);
    if (latest !== null && manifest.version === latest) manifest.version = bumpPatch(latest);
    return manifest;
  }
  const skillMd = new TextDecoder().decode(files["SKILL.md"]!);
  const meta = extractSkillMeta(skillMd);
  const pinned = frontmatterVersion(skillMd);
  const version =
    pinned !== undefined && pinned !== latest
      ? pinned
      : latest === null
        ? "1.0.0"
        : bumpPatch(latest);
  return {
    name: packageId,
    version,
    type,
    schema_version: "0.1",
    display_name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
  };
}

/** Create the package in `spaceId` (default: the pinned space), which becomes its home. The server publishes its first version. */
async function createPackage(
  session: Session,
  type: PackageType,
  manifest: Record<string, unknown>,
  files: Record<string, Uint8Array>,
  entry: string | null,
  spaceId: string | undefined,
): Promise<LocatedPackage> {
  const annexes: Record<string, Uint8Array> = { ...files };
  delete annexes[MANIFEST];
  const content = entry ? new TextDecoder().decode(files[entry]!) : "";
  if (entry) delete annexes[entry];
  const operations = Object.keys(annexes)
    .sort()
    .map((path) => writeOperation(path, annexes[path]!));
  if (operations.length > MAX_OPERATIONS_PER_PUT) {
    throw new Error(
      `${operations.length} files: creation takes at most ${MAX_OPERATIONS_PER_PUT}. Create it with fewer files, then push the rest.`,
    );
  }
  const detail = await apiFetch<Parameters<typeof toLocated>[2]>(
    session.profileName,
    packageCollectionPath(type),
    {
      method: "POST",
      body: JSON.stringify({ manifest, content, ...(operations.length > 0 ? { operations } : {}) }),
      ...(spaceId ? { spaceId } : {}),
    },
  );
  return toLocated(manifest.name as string, type, detail);
}

/**
 * The server stores the VALIDATED manifest, which may normalize what the author
 * wrote. Writing it back keeps the folder equal to the draft, so the next
 * status is clean instead of reporting a manifest change nobody made.
 */
async function rewriteManifest(
  dir: string,
  manifest: Record<string, unknown> | undefined,
): Promise<void> {
  if (!manifest) return;
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

// ─── publish ─────────────────────────────────────────────────────────────

export interface PackagesPublishOptions {
  profile?: string;
  /** `@scope/name`, or a bare name under the organization's slug. */
  package: string;
  /** Version to cut. Default: the draft manifest's `version`. */
  version?: string;
}

export async function packagesPublishCommand(
  opts: PackagesPublishOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const session = await openSession(opts.profile, io);
  if (!session) return;
  try {
    const packageId = await resolvePackageId(session, opts.package);
    const located = await locatePackage(session.profileName, packageId);
    if (!located) throw new Error(`${packageId}: no package with this id that you can read.`);
    if (!located.homeWritable) {
      throw new Error(
        `You cannot publish ${packageId}: that needs write access in its home space (${located.homeSpaceId}).`,
      );
    }
    let created: { version?: unknown };
    try {
      created = await apiFetch<{ version?: unknown }>(
        session.profileName,
        `${packagePath(located.type, packageId)}/versions`,
        {
          method: "POST",
          body: JSON.stringify(opts.version ? { version: opts.version } : {}),
          spaceId: located.homeSpaceId,
        },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        throw new Error(
          "That version is already published: pass --version <next>, or bump `version` and push again",
          { cause: err },
        );
      }
      throw err;
    }
    const version = typeof created.version === "string" ? created.version : "?";
    io.stdout.write(`Published ${packageId}@${version} (${located.type}).\n`);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}
