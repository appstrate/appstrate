// SPDX-License-Identifier: Apache-2.0

export type { ConnectionStatus } from "./status.ts";
export { getConnectionStatus, hasActiveConnection, resolveProviderStatuses } from "./status.ts";

export { initiateConnection, handleCallback, handleOAuth1CallbackAndSave } from "./oauth.ts";

export { saveApiKeyConnection, saveCredentialsConnection } from "./credentials.ts";

export {
  listActorConnections,
  disconnectProvider,
  disconnectConnectionById,
  deleteAllActorConnections,
  validateScopes,
} from "./operations.ts";

export {
  getProviderAuthMode,
  getAvailableProvidersWithStatus,
  listAllActorConnections,
} from "./providers.ts";
