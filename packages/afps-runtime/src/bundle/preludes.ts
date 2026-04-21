// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * System-prelude resolution (AFPS 1.2+).
 *
 * `systemPreludes` is an ordered list of `{ name, version }` entries in
 * an agent manifest. Each entry references a separately-published AFPS
 * package whose `prompt.md` is deterministically concatenated before
 * the agent's own `prompt.md` at render time.
 *
 * Key guarantees the runtime enforces:
 *
 *   - **Deterministic inclusion**: preludes are concatenated by the
 *     runtime before the LLM receives anything. The LLM has no opt-out
 *     (unlike skills, which are pull-mode).
 *   - **Stable ordering**: preludes render in manifest-declaration order.
 *     Two platforms declaring the same preludes in the same order get
 *     the same final prompt.
 *   - **Logic-less composition**: prelude prompts go through the same
 *     Mustache render pass as the agent prompt, against the same
 *     `PromptView`. A prelude that references `{{providers}}` sees the
 *     identical value the agent template would see.
 *
 * Preludes are not a dependency mechanism — they are a prompt-composition
 * mechanism. They do not contribute tools, skills, or config schemas.
 */

/**
 * Manifest-level entry describing one prelude. Mirrors the
 * `systemPreludes[]` shape defined in `@afps-spec/schema@1.4+`.
 */
export interface PreludeRef {
  /** `@scope/name` identifier of the prelude package. */
  name: string;
  /** Semver range matched by the resolver against published artifacts. */
  version: string;
}

/**
 * Strategy for fetching a prelude's prompt given a `{ name, version }`
 * pair. Intentionally narrow — the runtime does not care whether the
 * prelude lives in a local bundle store, an OCI registry, or an HTTP
 * endpoint; consumers supply whichever implementation fits their
 * distribution model.
 */
export interface PreludeResolver {
  /**
   * Resolve a single prelude's `prompt.md` contents. Implementations
   * MUST return the raw template string (logic-less Mustache is applied
   * by the runtime). Resolvers MAY cache by identity but the runtime
   * does no caching itself — it calls `resolve` once per render.
   *
   * Return `null` when the prelude is not found. The runtime treats a
   * missing prelude as a hard failure and throws {@link PreludeResolutionError}
   * from the render path.
   */
  resolve(ref: PreludeRef): Promise<string | null>;
}

export class PreludeResolutionError extends Error {
  constructor(
    public readonly ref: PreludeRef,
    message: string,
  ) {
    super(message);
    this.name = "PreludeResolutionError";
  }
}

/**
 * Fetch and concatenate every prelude's `prompt.md` in the order they
 * appear in `refs`. Returns the combined raw template (not yet rendered
 * — the caller applies the Mustache pass once against the full string
 * so preludes and agent share a single render and a single view).
 *
 * The empty case (`refs` empty or undefined) returns `""` so the caller
 * can unconditionally `concat(prelude, "\n\n", agent)`.
 */
export async function resolvePreludes(
  refs: readonly PreludeRef[] | undefined,
  resolver: PreludeResolver | undefined,
  opts: { separator?: string } = {},
): Promise<string> {
  if (!refs || refs.length === 0) return "";
  if (!resolver) {
    throw new PreludeResolutionError(
      refs[0]!,
      `Manifest declares systemPreludes but no PreludeResolver was provided`,
    );
  }
  const separator = opts.separator ?? "\n\n";
  const parts: string[] = [];
  for (const ref of refs) {
    const prompt = await resolver.resolve(ref);
    if (prompt === null) {
      throw new PreludeResolutionError(
        ref,
        `Prelude ${ref.name}@${ref.version} could not be resolved`,
      );
    }
    parts.push(prompt);
  }
  return parts.join(separator);
}

/**
 * In-memory {@link PreludeResolver} backed by a `Record<`id@version`, string>`
 * lookup table. Useful for tests and for consumers that have already
 * loaded their prelude catalogue (e.g. Appstrate's `package_versions`).
 *
 * Matching is exact on `name` + `version` — the resolver does not
 * interpret semver ranges itself. Upstream consumers are expected to
 * pre-resolve ranges to concrete versions before indexing the map.
 */
export class MapPreludeResolver implements PreludeResolver {
  constructor(private readonly store: Map<string, string>) {}

  async resolve(ref: PreludeRef): Promise<string | null> {
    return this.store.get(`${ref.name}@${ref.version}`) ?? null;
  }
}
