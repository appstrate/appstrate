// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, PreludeRef, PreludeResolver, ResolvedPrelude } from "./types.ts";

export class BundledPreludeResolutionError extends Error {
  constructor(
    public readonly ref: PreludeRef,
    message: string,
  ) {
    super(message);
    this.name = "BundledPreludeResolutionError";
  }
}

/**
 * Default {@link PreludeResolver}. Each prelude ships as `prompt.md`
 * under `.agent-package/preludes/{scoped-name}/`. Missing non-optional
 * refs fail fail-closed; `ref.optional === true` skips silently.
 *
 * Note: prelude content is emitted in manifest-declaration order by the
 * Runner, not here — this resolver only locates the bytes.
 */
export class BundledPreludeResolver implements PreludeResolver {
  constructor(
    private readonly opts: {
      /** Directory prefix inside the bundle. Defaults to `.agent-package/preludes/`. */
      prefix?: string;
      /** Override filename. Defaults to `prompt.md`. */
      filename?: string;
    } = {},
  ) {}

  async resolve(refs: PreludeRef[], bundle: Bundle): Promise<ResolvedPrelude[]> {
    const prefix = this.opts.prefix ?? ".agent-package/preludes/";
    const filename = this.opts.filename ?? "prompt.md";
    const out: ResolvedPrelude[] = [];

    for (const ref of refs) {
      const path = `${prefix}${ref.name}/${filename}`;
      if (!(await bundle.exists(path))) {
        if (ref.optional === true) continue;
        throw new BundledPreludeResolutionError(
          ref,
          `bundled prelude ${ref.name} has no ${filename} under ${prefix}${ref.name}/`,
        );
      }
      const content = await bundle.readText(path);
      out.push({ name: ref.name, version: ref.version, content });
    }
    return out;
  }
}
