// SPDX-License-Identifier: Apache-2.0

/**
 * Provider credential modals (API key / custom credentials) were removed
 * along with the provider package type. Integration connections use their
 * own connect surfaces (`components/integration-connect/`). This component
 * is retained as a no-op so existing render sites keep compiling.
 */
export function AgentModals(_props: { packageId: string }) {
  return null;
}
