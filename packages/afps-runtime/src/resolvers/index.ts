// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 runtime resolvers.
 *
 * Four interfaces, each mirroring a category of `dependencies.*` plus
 * `systemPreludes[]` on an agent manifest. The runtime supplies default
 * "bundled" implementations that read content shipped inside the `.afps`
 * file; runners supply external implementations (notably `ProviderResolver`)
 * for anything that lives outside the bundle.
 *
 * Specification: `afps-spec/schema/src/interfaces.ts` (§8).
 */

export type {
  Bundle,
  DependencyRef,
  ToolRef,
  ProviderRef,
  SkillRef,
  PreludeRef,
  JSONSchema,
  Tool,
  ToolContext,
  ToolResult,
  ResolvedSkill,
  ResolvedPrelude,
  ToolResolver,
  ProviderResolver,
  SkillResolver,
  PreludeResolver,
  SpecRunResult,
} from "./types.ts";

export {
  BundledToolResolver,
  BundledToolResolutionError,
  type BundledToolModule,
} from "./bundled-tool-resolver.ts";
export { BundledSkillResolver, BundledSkillResolutionError } from "./bundled-skill-resolver.ts";
export {
  BundledPreludeResolver,
  BundledPreludeResolutionError,
} from "./bundled-prelude-resolver.ts";
export { toBundle, type BundleAdapter } from "./bundle-adapter.ts";
