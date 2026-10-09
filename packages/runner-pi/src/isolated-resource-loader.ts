// SPDX-License-Identifier: Apache-2.0

import type { ExtensionFactory, PiCodingAgentSdk } from "./pi-sdk.ts";

interface IsolatedResourceLoaderOptions extends Pick<
  PiCodingAgentSdk,
  "DefaultResourceLoader" | "SettingsManager"
> {
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  extensionFactories: ExtensionFactory[];
  /** Skill files or directories the caller provides — the only skills the session sees. */
  skillPaths: string[];
}

const NO_PACKAGE_RESOURCES = {
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
} as const;

/**
 * A Pi resource loader that sees only what its caller passes: the system
 * prompt, the inline extension factories and the listed skill paths.
 *
 * Left to itself, Pi reads whoever runs the process: `~/.agents/skills`,
 * `<agentDir>/{extensions,skills,prompts,themes}`, `.agents/skills` in every
 * ancestor of `cwd`, `AGENTS.md`/`CLAUDE.md` in `agentDir` and every ancestor of
 * `cwd`, and `APPEND_SYSTEM.md`. A run on the host (`RUN_ADAPTER=process`, the
 * CLI) or a chat turn must not inherit any of it.
 *
 * Pi's package manager scans the user-scope directories before it consults
 * `noSkills` and its sibling flags, so the flags alone do not stop the scan:
 * its two discovery calls are replaced with ones that resolve nothing.
 * `packageManager` is private in Pi's TypeScript surface but a normal instance
 * field at runtime.
 */
export async function createIsolatedResourceLoader({
  DefaultResourceLoader,
  SettingsManager,
  cwd,
  agentDir,
  systemPrompt,
  extensionFactories,
  skillPaths,
}: IsolatedResourceLoaderOptions): Promise<
  InstanceType<PiCodingAgentSdk["DefaultResourceLoader"]>
> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories,
    additionalSkillPaths: skillPaths,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
  });
  Reflect.set(resourceLoader, "packageManager", {
    resolve: async () => NO_PACKAGE_RESOURCES,
    resolveExtensionSources: async () => NO_PACKAGE_RESOURCES,
  });
  await resourceLoader.reload();
  return resourceLoader;
}
