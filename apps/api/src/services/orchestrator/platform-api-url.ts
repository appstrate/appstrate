// SPDX-License-Identifier: Apache-2.0

interface PlatformNetwork {
  hostname: string;
}

export async function resolveDockerPlatformApiUrl(options: {
  configuredUrl?: string;
  port: number;
  detectPlatformNetwork: () => Promise<PlatformNetwork | null>;
}): Promise<string> {
  if (options.configuredUrl) return options.configuredUrl;

  const platformNetwork = await options.detectPlatformNetwork();
  if (platformNetwork) return `http://${platformNetwork.hostname}:${options.port}`;
  return `http://host.docker.internal:${options.port}`;
}
