// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ResolvedSkill, SkillRef, SkillResolver } from "./types.ts";

export class BundledSkillResolutionError extends Error {
  constructor(
    public readonly ref: SkillRef,
    message: string,
  ) {
    super(message);
    this.name = "BundledSkillResolutionError";
  }
}

/**
 * Default {@link SkillResolver}. Each skill ships as `SKILL.md` under
 * `.agent-package/skills/{scoped-name}/`. The file opens with a YAML
 * frontmatter block — parsed opportunistically so consumers that want
 * to inspect it (e.g. to enforce a skill allow-list) can do so without
 * re-parsing the file.
 */
export class BundledSkillResolver implements SkillResolver {
  constructor(
    private readonly opts: {
      /** Directory prefix inside the bundle. Defaults to `.agent-package/skills/`. */
      prefix?: string;
      /** Override filename. Defaults to `SKILL.md`. */
      filename?: string;
    } = {},
  ) {}

  async resolve(refs: SkillRef[], bundle: Bundle): Promise<ResolvedSkill[]> {
    const prefix = this.opts.prefix ?? ".agent-package/skills/";
    const filename = this.opts.filename ?? "SKILL.md";
    const out: ResolvedSkill[] = [];

    for (const ref of refs) {
      const path = `${prefix}${ref.name}/${filename}`;
      if (!(await bundle.exists(path))) {
        throw new BundledSkillResolutionError(
          ref,
          `bundled skill ${ref.name} has no ${filename} under ${prefix}${ref.name}/`,
        );
      }
      const raw = await bundle.readText(path);
      const { body, frontmatter } = parseFrontmatter(raw);
      out.push({
        name: ref.name,
        version: ref.version,
        content: body,
        ...(frontmatter !== null ? { frontmatter } : {}),
      });
    }
    return out;
  }
}

/**
 * Minimal YAML-ish frontmatter parser — accepts `key: value` lines
 * between `---` fences. Sufficient for the AFPS skill frontmatter spec
 * (name, description, and a flat bag of extension fields). Returns
 * `body` with the frontmatter block stripped.
 */
function parseFrontmatter(raw: string): {
  body: string;
  frontmatter: Record<string, unknown> | null;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { body: raw, frontmatter: null };
  const block = match[1]!;
  const body = raw.slice(match[0]!.length);
  const fm: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    fm[key] = coerceScalar(value);
  }
  return { body, frontmatter: fm };
}

function coerceScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
