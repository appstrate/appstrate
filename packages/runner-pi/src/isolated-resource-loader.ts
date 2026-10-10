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
 * Pi's package manager scans the user-scope directories before it consults
 * `noSkills` and its sibling flags, so the flags alone do not stop the scan:
 * its two discovery calls are replaced with ones that resolve nothing.
 * `packageManager` is private in Pi's TypeScript surface but a normal instance
 * field at runtime. The guard fails loudly if a Pi version no longer exposes
 * those two methods, because an unpatched loader would scan the host.
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
  const live: unknown = Reflect.get(resourceLoader, "packageManager");
  if (
    typeof (live as { resolve?: unknown } | null)?.resolve !== "function" ||
    typeof (live as { resolveExtensionSources?: unknown }).resolveExtensionSources !== "function"
  ) {
    throw new Error(
      "Pi's DefaultResourceLoader no longer exposes packageManager.resolve/resolveExtensionSources: the host-isolation shim cannot be applied, and without it Pi would scan the host's skill and extension directories. Update packages/runner-pi/src/isolated-resource-loader.ts for this Pi version.",
    );
  }
  Reflect.set(resourceLoader, "packageManager", {
    resolve: async () => NO_PACKAGE_RESOURCES,
    resolveExtensionSources: async () => NO_PACKAGE_RESOURCES,
  });
  await resourceLoader.reload();
  return resourceLoader;
}
