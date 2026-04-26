// SPDX-License-Identifier: Apache-2.0

/**
 * Synthesise a Pi `SKILL.md` from a provider {@link BundlePackage}.
 *
 * Why: Pi's `loadSkills()` emits an `<available_skills>` block in its system
 * prompt that includes the imperative "Use the read tool to load a skill's
 * file when the task matches its description". LLMs follow that instruction
 * reliably for skills but routinely ignored the analogous "API docs at
 * `.pi/providers/<id>/PROVIDER.md`" hint we used to print in the Connected
 * Providers prompt section — there was no read-before-use directive there.
 *
 * Hijacking Pi's skill-discovery for providers eliminates that gap by
 * construction: every provider gets a SKILL.md whose body wraps the
 * upstream PROVIDER.md, and Pi's prompt formatter does the rest.
 *
 * Constraints baked into this module (enforced by Pi's loader,
 * `pi-coding-agent/dist/core/skills.js`):
 *   - frontmatter `name` regex `^[a-z0-9-]+$`, max 64 chars, no leading or
 *     trailing hyphen, no `--`, MUST equal the parent directory basename
 *   - description is mandatory (skills with empty description are dropped)
 *
 * The `name === parentDirName` rule forces a flat `.pi/skills/<flatName>/`
 * layout for synthesised skills — `provider-<scope>-<name>`. Nesting under
 * `.pi/skills/providers/<id>/` would put `/` in the parent dir name and
 * fail the regex.
 *
 * Description template (kept in sync with the prompt's cross-reference):
 *   `<displayName or id> API. <manifest.description>. READ this skill before
 *    any provider_call(providerId="<id>").`
 * The middle clause is omitted cleanly when `manifest.description` is empty.
 */

import type { BundlePackage } from "@appstrate/afps-runtime/bundle";
import { parsePackageIdentity } from "@appstrate/afps-runtime/bundle";

/** Max name length per Pi's skills loader (`MAX_NAME_LENGTH`). */
const MAX_SKILL_NAME_LENGTH = 64;

/** Prefix that disambiguates synthesised provider skills from regular skills. */
const SKILL_NAME_PREFIX = "provider-";

const SKILL_NAME_REGEX = /^[a-z0-9-]+$/;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export class ProviderSkillSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSkillSynthesisError";
  }
}

/**
 * Derive a Pi-conformant skill name from a package identifier.
 *
 *   `@appstrate/gmail`  → `provider-appstrate-gmail`
 *   `notion`            → `provider-notion`
 *   `@Org/Foo_Bar.Baz`  → `provider-org-foo-bar-baz`
 *
 * The result is validated against Pi's regex / length / hyphen rules and
 * throws {@link ProviderSkillSynthesisError} on any violation. When the
 * derived name exceeds `MAX_SKILL_NAME_LENGTH` it is truncated from the
 * tail (preserving the `provider-` prefix) and re-validated.
 */
export function deriveSkillName(packageId: string): string {
  if (typeof packageId !== "string" || packageId.trim() === "") {
    throw new ProviderSkillSynthesisError(`Cannot derive skill name from empty package id`);
  }

  // Strip leading `@` from scoped names so it doesn't survive normalisation.
  const stripped = packageId.startsWith("@") ? packageId.slice(1) : packageId;

  const normalised = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalised === "") {
    throw new ProviderSkillSynthesisError(
      `Package id '${packageId}' produced no usable name characters after normalisation`,
    );
  }

  let name = `${SKILL_NAME_PREFIX}${normalised}`;

  if (name.length > MAX_SKILL_NAME_LENGTH) {
    name = name.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-+$/g, "");
  }

  validateSkillName(name, packageId);
  return name;
}

function validateSkillName(name: string, sourcePackageId: string): void {
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new ProviderSkillSynthesisError(
      `Derived skill name '${name}' for provider '${sourcePackageId}' contains invalid characters (allowed: a-z, 0-9, hyphen)`,
    );
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    throw new ProviderSkillSynthesisError(
      `Derived skill name '${name}' for provider '${sourcePackageId}' must not start or end with a hyphen`,
    );
  }
  if (name.includes("--")) {
    throw new ProviderSkillSynthesisError(
      `Derived skill name '${name}' for provider '${sourcePackageId}' must not contain consecutive hyphens`,
    );
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new ProviderSkillSynthesisError(
      `Derived skill name '${name}' for provider '${sourcePackageId}' exceeds ${MAX_SKILL_NAME_LENGTH} characters`,
    );
  }
}

interface ProviderManifest {
  name?: unknown;
  description?: unknown;
  definition?: {
    authMode?: unknown;
    authorizedUris?: unknown;
    allowAllUris?: unknown;
    docsUrl?: unknown;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return out.length > 0 ? out : undefined;
}

function escapeYamlString(value: string): string {
  // Inline double-quoted scalar — escape backslash, double-quote, and newlines.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

/**
 * Build a `SKILL.md` payload for the given provider package.
 *
 * Returns the derived skill name (caller mkdirs `.pi/skills/<skillName>/`)
 * and the file contents. Throws {@link ProviderSkillSynthesisError} when
 * the package id cannot be normalised into a valid Pi skill name.
 */
export function synthesizeProviderSkill(pkg: BundlePackage): {
  skillName: string;
  content: Uint8Array;
} {
  const parsed = parsePackageIdentity(pkg.identity);
  const packageId = parsed?.packageId ?? pkg.identity;
  const skillName = deriveSkillName(packageId);

  const manifest = (pkg.manifest ?? {}) as ProviderManifest;
  const definition = isPlainObject(manifest.definition) ? manifest.definition : {};

  const displayName = asString(manifest.name) ?? packageId;
  const manifestDescription = asString(manifest.description);
  const authMode = asString(definition.authMode);
  const allowAllUris = definition.allowAllUris === true;
  const authorizedUris = asStringArray(definition.authorizedUris);
  const docsUrl = asString(definition.docsUrl);

  const descriptionParts: string[] = [`${displayName} API.`];
  if (manifestDescription) descriptionParts.push(`${manifestDescription}.`);
  descriptionParts.push(`READ this skill before any provider_call(providerId="${packageId}").`);
  const description = descriptionParts.join(" ");

  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${skillName}`);
  lines.push(`description: ${escapeYamlString(description)}`);
  lines.push("---");
  lines.push("");
  lines.push("## Provider metadata");
  lines.push("");
  lines.push(`- **providerId**: \`${packageId}\``);
  lines.push(`- **displayName**: ${displayName}`);
  if (authMode) lines.push(`- **authMode**: ${authMode}`);
  if (allowAllUris) {
    lines.push(`- **authorizedUris**: all public URLs (\`allowAllUris: true\`)`);
  } else if (authorizedUris) {
    lines.push(`- **authorizedUris**: ${authorizedUris.join(", ")}`);
  }
  if (docsUrl) lines.push(`- **docsUrl**: ${docsUrl}`);
  lines.push("");

  const providerMd = pkg.files.get("PROVIDER.md");
  if (providerMd) {
    lines.push("## API documentation");
    lines.push("");
    lines.push(TEXT_DECODER.decode(providerMd));
  } else {
    lines.push("## API documentation");
    lines.push("");
    lines.push(
      `No bundled PROVIDER.md ships with this provider. Consult the upstream service's official API documentation${docsUrl ? ` (${docsUrl})` : ""} before issuing provider_call requests.`,
    );
  }

  const content = TEXT_ENCODER.encode(lines.join("\n") + "\n");
  return { skillName, content };
}
