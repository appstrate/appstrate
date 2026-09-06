// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate packages push <dir>` and `appstrate packages publish <package>` —
 * the write half of the authoring loop, for every package type. `push` sends
 * a local folder (its manifest, its content file and every annex) to the
 * package's DRAFT through `POST /api/packages/import?draft=true`; for a skill,
 * `skills sync --source draft` then hands it back to the author's machine for a
 * real test. `publish` cuts the version everyone else resolves.
 */

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { extractSkillMeta } from "@appstrate/core/validation";
import { parseScopedName } from "@appstrate/core/naming";
import { zipArtifact } from "@appstrate/core/zip";
import { apiFetch, apiFetchRaw, ApiError } from "../lib/api.ts";
import {
  getDataDir,
  packageWorkDir,
  readConfig,
  resolveActiveProfile,
  resolveWorkDir,
  type Profile,
} from "../lib/config.ts";
import { assertNotInstallDir } from "./skills-pull.ts";
import { computeStatus, renderStatus } from "./skills-status.ts";
import {
  CONTENT_ENTRY,
  locatePackage,
  packagePath,
  PACKAGE_TYPES,
  typeOfFolder,
  type PackageType,
} from "../lib/packages.ts";
import { listOrgs } from "../lib/orgs.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { formatError } from "../lib/ui.ts";

export interface SkillsPushOptions {
  profile?: string;
  /**
   * Folder holding `SKILL.md` (annex files are taken recursively), or a bare
   * skill name resolved in the work dir: `<workDir>/<org slug>/packages/skills/<name>`.
   */
  dir: string;
  /** `@scope/name` to push as. Default: the folder's `manifest.json`, else `@<org slug>/<frontmatter name>`. */
  id?: string;
  /** Overwrite a draft that has unpublished changes (`409 draft_overwrite`). */
  force?: boolean;
  /** Show what would be sent and send nothing. */
  dryRun?: boolean;
}

export interface SkillsPublishOptions {
  profile?: string;
  /** `@scope/name`, or a bare name resolved under the organization's slug. */
  skill: string;
  /** Version to cut; default: the draft manifest's `version`. */
  version?: string;
}

/** Never uploaded: tooling residue, not skill content. */
const SKIPPED_ENTRIES = new Set([".git", ".DS_Store", "node_modules", ".venv", "__pycache__"]);

const MANIFEST = "manifest.json";
const SKILL_ENTRY = "SKILL.md";

export async function skillsPushCommand(
  opts: SkillsPushOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  if (!requireOrg(profileName, profile, io)) return;

  let dir: string;
  let files: Record<string, Uint8Array>;
  try {
    dir = await resolveSkillFolder(profileName, profile!, opts.dir);
    files = await readSkillFolder(dir);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }

  const type = typeOfFolder(files);
  if (!type) {
    io.stderr.write(
      `${dir}: no manifest.json and no SKILL.md — an agent, integration or MCP server folder needs its manifest.json; a skill folder needs at least SKILL.md.\n`,
    );
    io.exit(1);
    return;
  }
  const skillMd = files[SKILL_ENTRY] ? new TextDecoder().decode(files[SKILL_ENTRY]) : "";
  const meta = type === "skill" ? extractSkillMeta(skillMd) : { name: "", description: "" };
  if (type === "skill" && !meta.name) {
    io.stderr.write(`${join(dir, SKILL_ENTRY)}: frontmatter has no \`name\`.\n`);
    io.exit(1);
    return;
  }
  const entry = CONTENT_ENTRY[type];
  if (entry && !files[entry] && type !== "integration") {
    io.stderr.write(`${dir}: a ${type} folder needs ${entry}.\n`);
    io.exit(1);
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = await resolveManifest(profileName, profile, files, meta, skillMd, opts.id, type);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }
  files[MANIFEST] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const packageId = manifest.name as string;
  const version = manifest.version as string;

  // What this push changes, shown before anything leaves the machine. A folder
  // that matches the draft has nothing to say to the server.
  let status: Awaited<ReturnType<typeof computeStatus>>;
  try {
    status = await computeStatus(profileName, profile!, files, packageId, type);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }
  io.stderr.write(renderStatus(status, dir, files, false));
  if (!status.isNew && status.changes.length === 0) {
    // Same files, but the draft may still declare a version that is already
    // published: the only thing this push changes is the version it will
    // publish as, and that is worth sending.
    if (status.remoteVersion === null || status.remoteVersion === version) {
      io.stdout.write(`Nothing to push: ${packageId} matches its draft.\n`);
      return;
    }
    io.stderr.write(
      `Files unchanged; the draft declares version ${status.remoteVersion}, which is already published. Writing it as ${version}.\n`,
    );
  }

  const paths = Object.keys(files).sort();
  if (opts.dryRun) {
    io.stdout.write(`${packageId} draft ← ${dir} (would publish as ${version}, dry run)\n`);
    return;
  }

  const archive = zipArtifact(files);
  const form = new FormData();
  const fileName = `${parseScopedName(packageId)!.name}.afps`;
  form.append("file", new File([archive], fileName, { type: "application/zip" }));
  // The lock this machine received from its previous push: with it, re-pushing
  // one's own work needs no --force, and a 409 means a real edit elsewhere.
  const locks = await readPushLocks(profileName);
  const knownLock = locks[packageId];
  const query =
    `?draft=true${opts.force ? "&force=true" : ""}` +
    (knownLock !== undefined ? `&lock_version=${knownLock}` : "");

  let res: Response;
  try {
    res = await importWithBackoff(profileName, query, form, io);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }
  if (!res.ok) {
    io.stderr.write(`${await describeFailure(res, packageId)}\n`);
    io.exit(1);
    return;
  }

  // An instance that predates `?draft=true` ignores the flag and publishes:
  // say so, because the author believed nothing left their machine.
  const outcome = (await res.json().catch(() => ({}))) as {
    draft?: unknown;
    version?: unknown;
    lock_version?: unknown;
  };
  if (outcome.draft !== true) {
    const published = typeof outcome.version === "string" ? `@${outcome.version}` : "";
    io.stderr.write(
      `Warning: this instance does not support draft imports and PUBLISHED ${packageId}${published} instead. Upgrade the instance, or delete that version if it was not meant to ship.\n`,
    );
    io.exit(1);
    return;
  }

  if (typeof outcome.lock_version === "number") {
    locks[packageId] = outcome.lock_version;
    await writePushLocks(profileName, locks);
  }

  io.stdout.write(
    `Pushed ${packageId} to its draft (${type}, ${paths.length} files, would publish as ${version}).\n`,
  );
  io.stderr.write(
    type === "skill"
      ? `Next: appstrate skills sync --source draft (test it here), then appstrate packages publish ${packageId}\n`
      : `Next: test the draft on Appstrate, then appstrate packages publish ${packageId}\n`,
  );
}

export async function skillsPublishCommand(
  opts: SkillsPublishOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  if (!requireOrg(profileName, profile, io)) return;

  let packageId: string;
  try {
    packageId = opts.skill.startsWith("@")
      ? opts.skill
      : `@${await orgSlug(profileName, profile!)}/${opts.skill}`;
    if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${packageId}`);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }

  try {
    const located = await locatePackage(profileName, profile!, packageId);
    if (!located) throw new Error(`${packageId} is not a package of this organization.`);
    const created = await apiFetch<{ version?: unknown }>(
      profileName,
      `${packagePath(located.type, packageId)}/versions`,
      { method: "POST", body: JSON.stringify(opts.version ? { version: opts.version } : {}) },
    );
    const version = typeof created.version === "string" ? created.version : "?";
    io.stdout.write(`Published ${packageId}@${version} (${located.type}).\n`);
    io.stderr.write(
      located.type === "skill"
        ? `Every machine syncing published skills picks it up on its next sync.\n`
        : `Agents and spaces that depend on it resolve the new version on their next run.\n`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      io.stderr.write(
        `${formatError(err)}\nThat version is already published: pass --version <next>, or bump \`version\` and push again.\n`,
      );
    } else {
      io.stderr.write(`${formatError(err)}\n`);
    }
    io.exit(1);
  }
}

/** The import route allows 10 requests a minute; a bulk push is the one caller that hits it. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_FALLBACK_SECONDS = 60;

/**
 * POST the archive, and on `429` wait what the server asks (`Retry-After`, else
 * a minute) and try again, a bounded number of times. A migration of fifty
 * skills must not need a hand-written pacing loop around the CLI.
 */
async function importWithBackoff(
  profileName: string,
  query: string,
  form: FormData,
  io: CommandIO,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await apiFetchRaw(profileName, `/api/packages/import${query}`, {
      method: "POST",
      body: form,
    });
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
    const header = Number(res.headers.get("retry-after"));
    const seconds =
      Number.isFinite(header) && header > 0 ? Math.ceil(header) : RATE_LIMIT_FALLBACK_SECONDS;
    io.stderr.write(
      `Rate limited (10 imports a minute): waiting ${seconds}s before retrying (${attempt + 1}/${RATE_LIMIT_RETRIES}).\n`,
    );
    await res.body?.cancel().catch(() => {});
    await sleep(seconds * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireOrg(profileName: string, profile: Profile | undefined, io: CommandIO): boolean {
  if (!profile) {
    io.stderr.write(
      `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    io.exit(1);
    return false;
  }
  if (!profile.orgId) {
    io.stderr.write("No organization pinned. Run: appstrate org switch\n");
    io.exit(1);
    return false;
  }
  return true;
}

/**
 * A path is used as given. A bare name (no separator, not an existing folder)
 * is the skill's working copy in the work dir, the folder `skills pull` fills.
 */
export async function resolveSkillFolder(
  profileName: string,
  profile: Profile,
  target: string,
): Promise<string> {
  const looksLikePath = target.includes("/") || target.startsWith(".") || target.startsWith("~");
  if (!looksLikePath) {
    try {
      if ((await stat(target)).isDirectory()) return resolve(target);
    } catch {
      // Not a folder here: fall through to the work dir.
    }
    const name = target.startsWith("@") ? parseScopedName(target)?.name : target;
    if (!name) throw new Error(`Not a package name: ${target}`);
    const config = await readConfig();
    await assertNotInstallDir(resolveWorkDir(config));
    const slug = await orgSlug(profileName, profile);
    const candidates = PACKAGE_TYPES.map((type) => packageWorkDir(config, slug, type, name));
    for (const dir of candidates) {
      try {
        if ((await stat(dir)).isDirectory()) return dir;
      } catch {
        // Try the next type's folder.
      }
    }
    throw new Error(
      `No working copy for ${target} under ${packageWorkDir(config, slug, "skill", "")}… Run: appstrate packages pull ${target}, or pass a folder path.`,
    );
  }
  return resolve(target.startsWith("~/") ? join(process.env.HOME ?? "", target.slice(2)) : target);
}

/** Every file under `dir`, keyed by its forward-slash path; `SKILL.md` required. */
export async function readSkillFolder(dir: string): Promise<Record<string, Uint8Array>> {
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

  if (!files[SKILL_ENTRY] && !files[MANIFEST]) {
    throw new Error(
      `${dir}: neither ${SKILL_ENTRY} nor ${MANIFEST} at the top level — a package folder starts with one of them.`,
    );
  }
  return files;
}

/**
 * The manifest the archive carries. A `manifest.json` in the folder is the
 * author's and passes through, `--id` aside. Otherwise one is synthesized so
 * the server takes the ordinary AFPS path — its skill-only fallback compares
 * `SKILL.md` alone and would answer `skill_unchanged` to a push that only
 * touched annex files.
 */
async function resolveManifest(
  profileName: string,
  profile: Profile | undefined,
  files: Record<string, Uint8Array>,
  meta: { name: string; description: string },
  skillMd: string,
  explicitId: string | undefined,
  type: PackageType,
): Promise<Record<string, unknown>> {
  if (explicitId && !parseScopedName(explicitId)) {
    throw new Error(`--id must be @scope/name, got "${explicitId}".`);
  }
  const authored = files[MANIFEST];
  if (authored) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(authored));
    } catch {
      throw new Error(`${MANIFEST} is not valid JSON.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${MANIFEST} must be a JSON object.`);
    }
    const manifest = { ...(parsed as Record<string, unknown>) };
    if (explicitId) manifest.name = explicitId;
    if (typeof manifest.name !== "string" || !parseScopedName(manifest.name)) {
      throw new Error(`${MANIFEST}: \`name\` must be @scope/name.`);
    }
    if (typeof manifest.version !== "string") {
      throw new Error(`${MANIFEST}: \`version\` is required.`);
    }
    // A folder that came from `skills pull` carries the published version's
    // manifest verbatim; publishing it again as-is would be refused. Move to
    // the next patch so push → publish works without editing the manifest.
    const latest = await latestPublished(profileName, manifest.name, type);
    if (latest !== null && manifest.version === latest) manifest.version = bumpPatch(latest);
    return manifest;
  }

  const packageId = explicitId ?? `@${await orgSlug(profileName, profile!)}/${meta.name}`;
  // A `version:` pinned in the frontmatter is the author's, unless it is the
  // version already published: then it is simply stale, and publishing it
  // again would be refused — move to the next patch, as for a pulled manifest.
  const latest = await latestPublished(profileName, packageId, "skill");
  const pinned = frontmatterVersion(skillMd);
  const version =
    pinned === undefined
      ? latest === null
        ? "1.0.0"
        : bumpPatch(latest)
      : pinned === latest
        ? bumpPatch(latest)
        : pinned;
  return {
    name: packageId,
    version,
    type: "skill",
    schema_version: "0.1",
    display_name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
  };
}

/** `<data dir>/skills-push/<profile>.json`: package id → lock_version of this machine's last push. */
export function getPushLocksPath(profileName: string): string {
  return join(getDataDir(), "skills-push", `${profileName}.json`);
}

export async function readPushLocks(profileName: string): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(getPushLocksPath(profileName), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    // Missing or unreadable: the next push simply carries no lock.
    return {};
  }
}

export async function writePushLocks(
  profileName: string,
  locks: Record<string, number>,
): Promise<void> {
  const path = getPushLocksPath(profileName);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(locks, null, 2)}\n`, { mode: 0o600 });
}

async function orgSlug(profileName: string, profile: Profile): Promise<string> {
  const org = (await listOrgs(profileName)).find((o) => o.id === profile.orgId);
  if (!org) {
    throw new Error(
      `Organization ${profile.orgId} is not one this profile belongs to. Run: appstrate org switch`,
    );
  }
  return org.slug;
}

/** `version:` in the frontmatter, when the author pins it there. */
export function frontmatterVersion(skillMd: string): string | undefined {
  const block = skillMd.match(/^---[^\S\n]*\n([\s\S]*?)\n---/)?.[1];
  const line = block?.match(/^version:[ \t]*["']?([0-9]+\.[0-9]+\.[0-9]+[^"'\s]*)["']?[ \t]*$/m);
  return line?.[1];
}

/** The latest published version, or `null` when nothing was ever published. */
async function latestPublished(
  profileName: string,
  packageId: string,
  type: PackageType,
): Promise<string | null> {
  try {
    const latest = await apiFetch<{ version?: unknown }>(
      profileName,
      `${packagePath(type, packageId)}/versions/latest`,
    );
    return typeof latest.version === "string" ? latest.version : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function bumpPatch(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "1.0.0";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

async function describeFailure(res: Response, packageId: string): Promise<string> {
  let body: { code?: unknown; detail?: unknown; message?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not JSON: the status line is all there is.
  }
  const detail = [body.detail, body.message].find((v): v is string => typeof v === "string");
  const head = `Push of ${packageId} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
  switch (body.code) {
    case "draft_overwrite":
      return `${head}\nThe draft was edited elsewhere (chat, API, or another machine) since this machine last pushed it. Re-run with --force to replace it.`;
    case "name_collision":
      return `${head}\nPick another id with --id @scope/name.`;
    default:
      return head;
  }
}
