// SPDX-License-Identifier: Apache-2.0

import type { ExtensionFactory, PiCodingAgentSdk } from "@appstrate/runner-pi";

type PiChatResourceLoaderSdk = Pick<PiCodingAgentSdk, "DefaultResourceLoader" | "SettingsManager">;

interface CreatePiChatResourceLoaderOptions extends PiChatResourceLoaderSdk {
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  extensionFactories: ExtensionFactory[];
}

const EMPTY_RESOLVED_PATHS = {
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
} as const;

/**
 * Pi 0.84 applies `noSkills` and its sibling flags after its package manager
 * has synchronously scanned global resource directories. Chat has no package
 * resources by policy, so short-circuit the two discovery calls used by
 * `DefaultResourceLoader.reload()` while retaining Pi's inline-extension
 * loader and runtime.
 *
 * `packageManager` is private in Pi's TypeScript surface but remains a normal
 * instance field at runtime. Keeping this compatibility shim in one module
 * makes it easy to remove when Pi exposes package-manager injection publicly.
 */
function disablePackageDiscovery(resourceLoader: object): void {
  const packageManager = {
    resolve: async () => EMPTY_RESOLVED_PATHS,
    resolveExtensionSources: async () => EMPTY_RESOLVED_PATHS,
  };
  Reflect.set(resourceLoader, "packageManager", packageManager);
}

/**
 * Load only resources supplied explicitly by the Appstrate chat turn.
 *
 * Local Pi extensions, skills and context files belong to the coding runtime,
 * not to the multitenant chat process. Chat capabilities arrive through the
 * scoped Appstrate MCP extension factories passed here.
 */
export async function createPiChatResourceLoader({
  DefaultResourceLoader,
  SettingsManager,
  cwd,
  agentDir,
  systemPrompt,
  extensionFactories,
}: CreatePiChatResourceLoaderOptions): Promise<
  InstanceType<PiCodingAgentSdk["DefaultResourceLoader"]>
> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  disablePackageDiscovery(resourceLoader);
  await resourceLoader.reload();
  return resourceLoader;
}
