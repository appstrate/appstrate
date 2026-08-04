// SPDX-License-Identifier: Apache-2.0

interface ManagedContainerSummary {
  Id: string;
  State: string;
}

export async function removeTerminalManagedContainers(
  containers: ManagedContainerSummary[],
  removeContainer: (containerId: string) => Promise<void>,
): Promise<number> {
  const terminalContainers = containers.filter(
    (container) => container.State === "exited" || container.State === "dead",
  );
  const results = await Promise.allSettled(
    terminalContainers.map((container) => removeContainer(container.Id)),
  );
  return results.filter((result) => result.status === "fulfilled").length;
}
